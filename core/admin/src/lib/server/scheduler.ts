/**
 * In-process automation scheduler — replaces system cron.
 *
 * Uses Croner for cron job scheduling within the Node.js process.
 * Automations are .yml files in STATE_HOME/automations/ with three
 * action types: api (admin API call), http (any URL), shell (execFile).
 *
 * Security: shell actions use execFile with argument arrays — no shell
 * interpolation. API actions auto-inject the admin token.
 */
import { Cron } from "croner";
import { parse as parseYaml } from "yaml";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@openpalm/lib/shared/logger";

const logger = createLogger("scheduler");

// ── Types ─────────────────────────────────────────────────────────────

export type ActionType = "api" | "http" | "shell";

export type AutomationAction = {
  type: ActionType;
  method?: string;
  path?: string;
  url?: string;
  body?: unknown;
  headers?: Record<string, string>;
  command?: string[];
  timeout?: number;
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

type ActiveJob = {
  cron: Cron;
  config: AutomationConfig;
};

// ── Execution Log ─────────────────────────────────────────────────────

export type ExecutionLogEntry = {
  at: string;
  ok: boolean;
  durationMs: number;
  error?: string;
};

const MAX_LOG_ENTRIES = 50;
const executionLogs = new Map<string, ExecutionLogEntry[]>();

function recordExecution(fileName: string, entry: ExecutionLogEntry): void {
  let entries = executionLogs.get(fileName);
  if (!entries) {
    entries = [];
    executionLogs.set(fileName, entries);
  }
  entries.push(entry);
  if (entries.length > MAX_LOG_ENTRIES) {
    executionLogs.set(fileName, entries.slice(-MAX_LOG_ENTRIES));
  }
}

/** Return recent execution log entries for an automation (newest first). */
export function getExecutionLog(fileName: string): ExecutionLogEntry[] {
  return [...(executionLogs.get(fileName) ?? [])].reverse();
}

/** Return all execution logs keyed by fileName. */
export function getAllExecutionLogs(): Record<string, ExecutionLogEntry[]> {
  const result: Record<string, ExecutionLogEntry[]> = {};
  for (const [fileName, entries] of executionLogs) {
    result[fileName] = [...entries].reverse();
  }
  return result;
}

// ── Schedule Presets ──────────────────────────────────────────────────

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

/**
 * Resolve a schedule string: if it matches a preset name, return the
 * cron expression; otherwise pass through as-is (assumed cron syntax).
 */
export function resolveSchedule(schedule: string): string {
  return SCHEDULE_PRESETS[schedule] ?? schedule;
}

// ── YAML Parsing ──────────────────────────────────────────────────────

/**
 * Parse and validate a YAML automation file.
 * Returns null if the content is invalid (with a warning logged).
 */
export function parseAutomationYaml(
  content: string,
  fileName: string
): AutomationConfig | null {
  let doc: Record<string, unknown>;
  try {
    doc = parseYaml(content) as Record<string, unknown>;
  } catch (err) {
    logger.warn("failed to parse automation YAML", { fileName, error: String(err) });
    return null;
  }

  if (!doc || typeof doc !== "object") {
    logger.warn("automation YAML is not an object", { fileName });
    return null;
  }

  // schedule is required
  const rawSchedule = doc.schedule;
  if (typeof rawSchedule !== "string" || !rawSchedule.trim()) {
    logger.warn("automation missing or empty 'schedule'", { fileName });
    return null;
  }

  // action is required and must be an object with a valid type
  const action = doc.action;
  if (!action || typeof action !== "object") {
    logger.warn("automation missing or invalid 'action'", { fileName });
    return null;
  }

  const actionObj = action as Record<string, unknown>;
  const actionType = actionObj.type as string | undefined;
  if (!actionType || !["api", "http", "shell"].includes(actionType)) {
    logger.warn("automation action has invalid 'type'", {
      fileName,
      type: String(actionType)
    });
    return null;
  }

  // Validate action-specific required fields
  if (actionType === "api" && typeof actionObj.path !== "string") {
    logger.warn("api action missing 'path'", { fileName });
    return null;
  }
  if (actionType === "http" && typeof actionObj.url !== "string") {
    logger.warn("http action missing 'url'", { fileName });
    return null;
  }
  if (actionType === "shell") {
    if (!Array.isArray(actionObj.command) || actionObj.command.length === 0) {
      logger.warn("shell action missing or empty 'command' array", { fileName });
      return null;
    }
  }

  const schedule = resolveSchedule(rawSchedule.trim());

  return {
    name: typeof doc.name === "string" ? doc.name : fileName.replace(/\.yml$/, ""),
    description: typeof doc.description === "string" ? doc.description : "",
    schedule,
    timezone: typeof doc.timezone === "string" ? doc.timezone : "UTC",
    enabled: doc.enabled !== false,
    action: {
      type: actionType as ActionType,
      method: typeof actionObj.method === "string" ? actionObj.method : "GET",
      path: typeof actionObj.path === "string" ? actionObj.path : undefined,
      url: typeof actionObj.url === "string" ? actionObj.url : undefined,
      body: actionObj.body,
      headers: isStringRecord(actionObj.headers) ? actionObj.headers : undefined,
      command: Array.isArray(actionObj.command)
        ? actionObj.command.map(String)
        : undefined,
      timeout:
        typeof actionObj.timeout === "number" ? actionObj.timeout : 30_000
    },
    on_failure:
      doc.on_failure === "audit" ? "audit" : "log",
    fileName
  };
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object") return false;
  return Object.values(v as Record<string, unknown>).every(
    (val) => typeof val === "string"
  );
}

// ── Load Automations ──────────────────────────────────────────────────

/**
 * Read and parse all .yml automation files from STATE_HOME/automations/.
 */
export function loadAutomations(stateDir: string): AutomationConfig[] {
  const dir = join(stateDir, "automations");
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir, { withFileTypes: true });
  const configs: AutomationConfig[] = [];

  for (const entry of files) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".yml")) {
      logger.warn("non-.yml file in automations dir (ignored)", {
        file: entry.name,
        hint: "automation files must use .yml extension"
      });
      continue;
    }

    const content = readFileSync(join(dir, entry.name), "utf-8");
    const config = parseAutomationYaml(content, entry.name);
    if (config) configs.push(config);
  }

  return configs;
}

// ── Action Execution ──────────────────────────────────────────────────

/** Execute an API action — auto-injects admin token and base URL. */
async function executeApiAction(
  action: AutomationAction,
  adminToken: string
): Promise<void> {
  const url = `http://localhost:8100${action.path}`;
  const headers: Record<string, string> = {
    "x-admin-token": adminToken,
    "x-requested-by": "automation",
    ...action.headers
  };
  if (action.body) {
    headers["content-type"] = "application/json";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), action.timeout ?? 30_000);
  try {
    const resp = await fetch(url, {
      method: action.method ?? "GET",
      headers,
      body: action.body ? JSON.stringify(action.body) : undefined,
      signal: controller.signal
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Execute an HTTP action — no auto-auth. */
async function executeHttpAction(action: AutomationAction): Promise<void> {
  const headers: Record<string, string> = { ...action.headers };
  if (action.body) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), action.timeout ?? 30_000);
  try {
    const resp = await fetch(action.url!, {
      method: action.method ?? "GET",
      headers,
      body: action.body ? JSON.stringify(action.body) : undefined,
      signal: controller.signal
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Execute a shell action — uses execFile with argument array (no shell interpolation). */
function executeShellAction(action: AutomationAction): Promise<void> {
  const cmd = action.command!;
  return new Promise((resolve, reject) => {
    execFile(
      cmd[0],
      cmd.slice(1),
      { env: { ...process.env }, timeout: action.timeout ?? 30_000 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`shell command failed: ${stderr || error.message}`));
        } else {
          resolve();
        }
      }
    );
  });
}

/** Dispatch to the correct action executor. */
export async function executeAction(
  action: AutomationAction,
  adminToken: string
): Promise<void> {
  switch (action.type) {
    case "api":
      return executeApiAction(action, adminToken);
    case "http":
      return executeHttpAction(action);
    case "shell":
      return executeShellAction(action);
  }
}

// ── Scheduler Lifecycle ───────────────────────────────────────────────

let activeJobs: ActiveJob[] = [];

/**
 * Start the in-process scheduler. Reads automations from STATE_HOME,
 * creates Croner jobs for each enabled one.
 */
export function startScheduler(stateDir: string, adminToken: string): void {
  const configs = loadAutomations(stateDir);
  const enabled = configs.filter((c) => c.enabled);

  for (const config of enabled) {
    try {
      const cron = new Cron(config.schedule, {
        timezone: config.timezone,
        protect: true // over-run protection
      }, async () => {
        const start = Date.now();
        try {
          await executeAction(config.action, adminToken);
          const durationMs = Date.now() - start;
          recordExecution(config.fileName, { at: new Date().toISOString(), ok: true, durationMs });
          logger.info("automation executed", { name: config.name, fileName: config.fileName, durationMs });
        } catch (err) {
          const durationMs = Date.now() - start;
          const errorMsg = String(err);
          recordExecution(config.fileName, { at: new Date().toISOString(), ok: false, durationMs, error: errorMsg });
          logger.error("automation failed", {
            name: config.name,
            fileName: config.fileName,
            error: errorMsg
          });
        }
      });

      activeJobs.push({ cron, config });
    } catch (err) {
      logger.error("failed to schedule automation", {
        name: config.name,
        fileName: config.fileName,
        schedule: config.schedule,
        error: String(err)
      });
    }
  }

  logger.info(`scheduler started with ${activeJobs.length} automation(s)`);
}

/** Stop all active Croner jobs. */
export function stopScheduler(): void {
  for (const job of activeJobs) {
    job.cron.stop();
  }
  const count = activeJobs.length;
  activeJobs = [];
  executionLogs.clear();
  if (count > 0) {
    logger.info(`scheduler stopped (${count} job(s) cleared)`);
  }
}

/** Reload: stop all jobs, then start fresh. */
export function reloadScheduler(stateDir: string, adminToken: string): void {
  stopScheduler();
  startScheduler(stateDir, adminToken);
}

/** Return current scheduler status for debugging. */
export function getSchedulerStatus(): {
  jobCount: number;
  jobs: { name: string; fileName: string; schedule: string; running: boolean }[];
} {
  return {
    jobCount: activeJobs.length,
    jobs: activeJobs.map((j) => ({
      name: j.config.name,
      fileName: j.config.fileName,
      schedule: j.config.schedule,
      running: j.cron.isRunning()
    }))
  };
}
