/**
 * Automation scheduler — types and akm CLI integration.
 *
 * Automations are AKM task files at ${stashDir}/tasks/*.yml.
 * Scheduling is handled by the OS cron daemon (via `akm task sync`).
 * Execution is handled by `akm task run <id>`.
 */
import { createLogger } from "../logger.js";
import {
  checkAssistantTaskSyncHealth,
  runAssistantAkmCommand,
} from "./assistant-akm.js";
import {
  AutomationRuntimeError,
  listAutomationTaskFiles,
  readAutomationTaskLogs,
} from './automation-runtime.js';
import {
  assertSchedulableTaskFilename,
  taskIdFromTaskFilename,
} from './task-file-contract.js';
import type { ControlPlaneState } from "./types.js";

const logger = createLogger("scheduler");

// ── Execute an automation via akm task run ────────────────────────────────

export interface AutomationRunResult {
  ok: boolean;
  status: string;
  error?: string;
}

type AutomationCommandRunner = typeof runAssistantAkmCommand;
type AutomationTaskSyncHealthChecker = typeof checkAssistantTaskSyncHealth;
type AutomationTaskFileLister = typeof listAutomationTaskFiles;
type AutomationLogReader = typeof readAutomationTaskLogs;

const AKM_NOT_FOUND_CODES = new Set([
  'ASSET_NOT_FOUND',
  'FILE_NOT_FOUND',
  'SOURCE_NOT_FOUND',
  'WORKFLOW_NOT_FOUND',
]);
const AKM_INVALID_REQUEST_CODES = new Set([
  'CONFIG_DIR_UNRESOLVABLE',
  'INVALID_CONFIG_FILE',
  'INVALID_FLAG_VALUE',
  'MISSING_REQUIRED_ARGUMENT',
  'PATH_ESCAPE_VIOLATION',
  'STASH_DIR_NOT_A_DIRECTORY',
  'STASH_DIR_NOT_FOUND',
  'STASH_DIR_UNREADABLE',
  'TASK_SCHEMA_VERSION_UNSUPPORTED',
  'UNSUPPORTED_CONFIG_VERSION',
]);

function parseAkmCommandError(stderr: string): { error: string; code?: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(stderr);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  const keys = Object.keys(envelope);
  if (
    envelope.ok !== false ||
    typeof envelope.error !== 'string' ||
    envelope.error.length === 0 ||
    envelope.error.length > 4_096 ||
    (envelope.code !== undefined &&
      (typeof envelope.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(envelope.code))) ||
    (envelope.hint !== undefined &&
      (typeof envelope.hint !== 'string' || envelope.hint.length > 4_096)) ||
    keys.some((key) => !['ok', 'error', 'code', 'hint'].includes(key))
  ) {
    return null;
  }
  return {
    error: envelope.error,
    ...(typeof envelope.code === 'string' ? { code: envelope.code } : {}),
  };
}

function failedAkmCommandError(
  result: Awaited<ReturnType<AutomationCommandRunner>>,
): AutomationRuntimeError {
  const parsed = parseAkmCommandError(result.stderr.trim());
  if (parsed === null) {
    return new AutomationRuntimeError('unavailable', 'Assistant automation execution is unavailable');
  }
  if (parsed.code !== undefined && AKM_NOT_FOUND_CODES.has(parsed.code)) {
    return new AutomationRuntimeError('not_found', parsed.error);
  }
  if (parsed.code === 'RESOURCE_ALREADY_EXISTS') {
    return new AutomationRuntimeError('conflict', parsed.error);
  }
  if (
    result.exitCode === 2 ||
    result.exitCode === 78 ||
    (parsed.code !== undefined && AKM_INVALID_REQUEST_CODES.has(parsed.code))
  ) {
    return new AutomationRuntimeError('invalid_request', parsed.error);
  }
  return new AutomationRuntimeError('invalid_response', 'AKM returned an invalid error response');
}

function schedulerTaskIdFromFilename(fileName: string): string {
  assertSchedulableTaskFilename(fileName);
  return taskIdFromTaskFilename(fileName);
}

export async function executeAutomation(
  state: ControlPlaneState,
  fileName: string,
  runCommand: AutomationCommandRunner = runAssistantAkmCommand,
): Promise<AutomationRunResult> {
  const taskId = schedulerTaskIdFromFilename(fileName);
  let result: Awaited<ReturnType<AutomationCommandRunner>>;
  try {
    result = await runCommand(state, ["task", "run", taskId, "--format", "json", "--quiet"], 0);
  } catch {
    logger.warn("akm task run transport failed", { id: taskId });
    throw new AutomationRuntimeError('unavailable', 'Assistant automation execution is unavailable');
  }
  if (result.missing) {
    logger.warn("akm task run is unavailable", { id: taskId, exitCode: result.exitCode });
    throw new AutomationRuntimeError('unavailable', 'AKM is unavailable in the Assistant');
  }
  if (result.transportError) {
    logger.warn('akm task run transport failed', { id: taskId });
    throw new AutomationRuntimeError('unavailable', 'Assistant automation execution is unavailable');
  }
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object");
    const envelope = value as Record<string, unknown>;
    if (
      envelope.shape !== "task-run" ||
      envelope.schemaVersion !== 1 ||
      typeof envelope.ok !== "boolean" ||
      typeof envelope.exitCode !== "number" ||
      !Number.isInteger(envelope.exitCode)
    ) {
      throw new Error("unsupported response envelope");
    }
    if (typeof envelope.result !== "object" || envelope.result === null || Array.isArray(envelope.result)) {
      throw new Error("missing task result");
    }
    const taskResult = envelope.result as Record<string, unknown>;
    if (
      typeof taskResult.status !== "string" ||
      !["completed", "blocked", "failed", "disabled", "active"].includes(taskResult.status)
    ) {
      throw new Error("invalid task status");
    }
    const expectedOk = taskResult.status === "completed" || taskResult.status === "disabled";
    if (envelope.ok !== expectedOk || envelope.exitCode !== result.exitCode) {
      throw new Error("inconsistent task result envelope");
    }
    const detail =
      typeof taskResult.detail === "object" && taskResult.detail !== null && !Array.isArray(taskResult.detail)
        ? taskResult.detail as Record<string, unknown>
        : undefined;
    const error = [detail?.error, detail?.reason].find((message): message is string => typeof message === "string");
    return {
      ok: envelope.ok,
      status: taskResult.status,
      ...(envelope.ok || error === undefined ? {} : { error }),
    };
  } catch {
    if (!result.ok && result.stdout.trim() === '') {
      const diagnostic = parseAkmCommandError(result.stderr.trim());
      logger.warn("akm task run failed without an envelope", {
        id: taskId,
        exitCode: result.exitCode,
        code: diagnostic?.code ?? 'unclassified',
      });
      throw failedAkmCommandError(result);
    }
    logger.warn("akm task run returned invalid output", { id: taskId });
    throw new AutomationRuntimeError('invalid_response', 'AKM returned an invalid task run response');
  }
}

export type AutomationRegistrationStatus =
  | {
    ok: true;
    localFileNames: string[];
    matchingSchedulerIds: string[];
    localOnlyFileNames: string[];
    schedulerOnlyTaskIds: string[];
    attribution: "unavailable";
  }
  | { ok: false; localFileNames: string[]; error: string };

export async function getAutomationRegistrationStatus(
  state: ControlPlaneState,
  runCommand: AutomationCommandRunner = runAssistantAkmCommand,
  listFiles: AutomationTaskFileLister = listAutomationTaskFiles,
  checkTaskSyncHealth: AutomationTaskSyncHealthChecker = checkAssistantTaskSyncHealth,
): Promise<AutomationRegistrationStatus> {
  let localFileMetadata: Awaited<ReturnType<AutomationTaskFileLister>>;
  try {
    localFileMetadata = await listFiles(state);
  } catch (error) {
    return {
      ok: false,
      localFileNames: [],
      error: `Unable to inspect task files: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const localFileNames = localFileMetadata.map((file) => file.fileName);
  const schedulableFiles = localFileMetadata.filter((file) => file.schedulable);
  try {
    const health = await checkTaskSyncHealth(state);
    if (!health.ok) {
      return {
        ok: false,
        localFileNames,
        error: `Task reconciliation health check failed: ${health.error}`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      localFileNames,
      error: `Task reconciliation health check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const result = await runCommand(state, ["task", "doctor", "--format", "json", "--quiet"], 10_000);
  if (!result.ok) {
    return {
      ok: false,
      localFileNames,
      error: result.stderr.trim() || result.stdout.trim() || `akm task doctor exited ${result.exitCode}`,
    };
  }

  try {
    const value: unknown = JSON.parse(result.stdout);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object");
    const doctor = value as Record<string, unknown>;
    if (doctor.shape !== "task-doctor" || doctor.schemaVersion !== 1) {
      throw new Error("unsupported response envelope");
    }
    if (doctor.backend !== "cron") throw new Error("expected cron backend");
    if (typeof doctor.akm !== "object" || doctor.akm === null || Array.isArray(doctor.akm)) {
      throw new Error("missing akm launcher status");
    }
    const akm = doctor.akm as Record<string, unknown>;
    if (akm.kind !== "npm" || akm.eligible !== true) throw new Error("AKM launcher is not npm-global eligible");
    if (!Array.isArray(doctor.warnings) || doctor.warnings.some((warning) => typeof warning !== "string")) {
      throw new Error("invalid warnings array");
    }
    if (doctor.warnings.length > 0) throw new Error(`doctor warnings: ${doctor.warnings.join("; ")}`);
    if (doctor.remediation !== undefined) throw new Error(`doctor requires remediation: ${String(doctor.remediation)}`);

    const bindings = doctor.bindings;
    if (!Array.isArray(bindings)) throw new Error("missing bindings array");
    const registeredSet = new Set<string>();
    for (const binding of bindings) {
      if (typeof binding !== "object" || binding === null || Array.isArray(binding)) {
        throw new Error("invalid binding");
      }
      const taskIds = (binding as Record<string, unknown>).taskIds;
      if (!Array.isArray(taskIds) || taskIds.some((id) => typeof id !== "string")) {
        throw new Error("invalid binding taskIds");
      }
      const status = (binding as Record<string, unknown>).status;
      if (!Array.isArray(status) || status.length !== 1 || status[0] !== "ok") {
        throw new Error(`unhealthy binding status: ${JSON.stringify(status)}`);
      }
      for (const id of taskIds as string[]) registeredSet.add(id);
    }
    const localTaskIds = new Set(schedulableFiles.map((file) => file.taskId));
    return {
      ok: true,
      localFileNames,
      matchingSchedulerIds: schedulableFiles
        .filter((file) => registeredSet.has(file.taskId))
        .map((file) => file.taskId),
      localOnlyFileNames: localFileMetadata
        .filter((file) => !file.schedulable || !registeredSet.has(file.taskId))
        .map((file) => file.fileName),
      schedulerOnlyTaskIds: [...registeredSet].filter((id) => !localTaskIds.has(id)),
      attribution: "unavailable",
    };
  } catch (error) {
    return {
      ok: false,
      localFileNames,
      error: `Invalid akm task doctor response: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── Read akm task execution logs ──────────────────────────────────────────
export async function readAutomationLogs(
  state: ControlPlaneState,
  fileName: string,
  limit = 50,
  readLogs: AutomationLogReader = readAutomationTaskLogs,
): Promise<string[]> {
  schedulerTaskIdFromFilename(fileName);
  return readLogs(state, fileName, limit);
}
