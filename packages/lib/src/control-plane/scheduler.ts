/**
 * Automation scheduler — types and akm CLI integration.
 *
 * Automations are AKM task files at ${stashDir}/tasks/*.yml.
 * Scheduling is handled by the OS cron daemon (via `akm task sync`).
 * Execution is handled by `akm task run <id>`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { runAssistantAkmCommand } from "./assistant-akm.js";
import { loadMarkdownTasks, taskToAutomationConfig } from "./markdown-task.js";
import { listTaskFiles } from "./task-files.js";
import type { ControlPlaneState } from "./types.js";

const logger = createLogger("scheduler");

// ── Types ─────────────────────────────────────────────────────────────────

export type ActionType = "api" | "http" | "shell" | "assistant" | "workflow";

export type AutomationAction = {
  type: ActionType;
  method?: string;
  path?: string;
  url?: string;
  content?: string;
  agent?: string;
};

export type AutomationConfig = {
  name: string;
  description: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  action: AutomationAction;
  on_failure: "log" | "audit";
  fileName: string;
};

// ── Schedule presets (UI display labels only) ─────────────────────────────

export const SCHEDULE_PRESETS: Record<string, string> = {
  "every-minute": "* * * * *",
  "every-5-minutes": "*/5 * * * *",
  "every-15-minutes": "*/15 * * * *",
  "every-hour": "0 * * * *",
  "daily": "0 0 * * *",
  "daily-8am": "0 8 * * *",
  "weekly": "0 0 * * 0",
  "weekly-sunday-3am": "0 3 * * 0",
  "weekly-sunday-4am": "0 4 * * 0"
};

// ── Load automations from AKM task files ──────────────────────────────────

export function loadAutomations(stashDir: string): AutomationConfig[] {
  return loadMarkdownTasks(stashDir).map(taskToAutomationConfig);
}

// ── Execute an automation via akm task run ────────────────────────────────

export interface AutomationRunResult {
  ok: boolean;
  status: string;
  error?: string;
}

type AutomationCommandRunner = typeof runAssistantAkmCommand;

export async function executeAutomation(
  state: ControlPlaneState,
  id: string,
  runCommand: AutomationCommandRunner = runAssistantAkmCommand,
): Promise<AutomationRunResult> {
  // Strip file suffix if caller passes the full filename.
  const taskId = id.replace(/\.yml$/, "");
  const result = await runCommand(state, ["task", "run", taskId, "--format", "json", "--quiet"], 0);
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
  } catch (error) {
    if (result.ok) {
      const message = `Invalid akm task run response: ${error instanceof Error ? error.message : String(error)}`;
      logger.warn("akm task run returned invalid output", { id: taskId, error: message });
      return { ok: false, status: "failed", error: message };
    }
  }
  if (!result.ok) {
    const error = result.stderr.trim() || result.stdout.trim() || `akm task run exited ${result.exitCode}`;
    logger.warn("akm task run failed", { id: taskId, error });
    return { ok: false, status: "failed", error };
  }
  return { ok: false, status: "failed", error: "akm task run returned no result" };
}

export type AutomationRegistrationStatus =
  | { ok: true; configured: string[]; registered: string[]; missing: string[] }
  | { ok: false; configured: string[]; error: string };

export async function getAutomationRegistrationStatus(
  state: ControlPlaneState,
  runCommand: AutomationCommandRunner = runAssistantAkmCommand,
): Promise<AutomationRegistrationStatus> {
  let configured: string[];
  try {
    configured = listTaskFiles(state.stashDir).map((file) => file.name.slice(0, -4));
  } catch (error) {
    return {
      ok: false,
      configured: [],
      error: `Unable to inspect task files: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (configured.length === 0) return { ok: true, configured, registered: [], missing: [] };

  const result = await runCommand(state, ["task", "doctor", "--format", "json", "--quiet"], 10_000);
  if (!result.ok) {
    return {
      ok: false,
      configured,
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
    const registered = configured.filter((id) => registeredSet.has(id));
    return { ok: true, configured, registered, missing: configured.filter((id) => !registeredSet.has(id)) };
  } catch (error) {
    return {
      ok: false,
      configured,
      error: `Invalid akm task doctor response: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── Read akm task execution logs ──────────────────────────────────────────

export function readAutomationLogs(
  id: string,
  dataDir: string,
  limit: number = 50,
): string[] {
  const taskId = id.replace(/\.yml$/, "");
  const logDir = join(dataDir, "akm", "cache", "tasks", "logs", taskId);
  if (!existsSync(logDir)) return [];

  const logFiles = readdirSync(logDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".log"))
    .map((e) => ({ name: e.name, path: join(logDir, e.name) }))
    .sort((a, b) => b.name.localeCompare(a.name)); // newest first (ISO timestamp names)

  const lines: string[] = [];
  for (const { path } of logFiles) {
    if (lines.length >= limit) break;
    try {
      const content = readFileSync(path, "utf-8");
      const fileLines = content.split("\n").filter(Boolean).reverse(); // newest within file last
      lines.push(...fileLines.slice(0, limit - lines.length));
    } catch {
      // skip unreadable log files
    }
  }
  return lines.slice(0, limit);
}
