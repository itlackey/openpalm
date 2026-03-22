/**
 * In-process automation scheduler — replaces system cron.
 *
 * Uses Croner for cron job scheduling within the Node.js process.
 * Automations are .yml files in STATE_HOME/automations/ with four
 * action types: api (admin API call), http (any URL), shell (execFile),
 * assistant (OpenCode session message).
 *
 * Security: shell actions use execFile with argument arrays — no shell
 * interpolation. API actions auto-inject the admin token. Assistant
 * actions validate the session ID before URL interpolation.
 */
import { Cron } from "croner";
import { parse as parseYaml } from "yaml";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const logger = createLogger("scheduler");

// ── Types ─────────────────────────────────────────────────────────────

export type ActionType = "api" | "http" | "shell" | "assistant";

export type AutomationAction = {
  type: ActionType;
  method?: string;
  path?: string;
  url?: string;
  body?: unknown;
  headers?: Record<string, string>;
  command?: string[];
  timeout?: number;
  /** The prompt text to send to the assistant (assistant action only). */
  content?: string;
  /** OpenCode agent label for the session (assistant action only, optional).
   *  Currently used in the session title for identification/audit purposes.
   *  Will be forwarded as an API parameter when OpenCode adds agent selection support. */
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
  if (!actionType || !["api", "http", "shell", "assistant"].includes(actionType)) {
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
  if (actionType === "assistant") {
    if (typeof actionObj.content !== "string" || !actionObj.content.trim()) {
      logger.warn("assistant action missing or empty 'content'", { fileName });
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
      content: typeof actionObj.content === "string" ? actionObj.content : undefined,
      agent: typeof actionObj.agent === "string" ? actionObj.agent : undefined,
      timeout:
        typeof actionObj.timeout === "number"
          ? actionObj.timeout
          : actionType === "assistant" ? 120_000 : 30_000
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
 * Read and parse all .yml automation files from config/automations/.
 */
export function loadAutomations(configDir: string): AutomationConfig[] {
  const dir = join(configDir, "automations");
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

export const SAFE_PATH_RE = /^\/admin\/[a-zA-Z0-9/._-]+$/;

/** Execute an API action — auto-injects admin token and base URL. */
async function executeApiAction(
  action: AutomationAction,
  adminToken: string
): Promise<void> {
  if (!action.path || !SAFE_PATH_RE.test(action.path) || action.path.includes('..')) {
    logger.warn(`Scheduler: rejecting unsafe action path: ${action.path}`);
    return;
  }
  const adminUrl = process.env.OP_ADMIN_API_URL || "http://admin:8100";
  const url = `${adminUrl}${action.path}`;
  const { "x-admin-token": _dropped, "authorization": _dropped2, ...safeHeaders } = action.headers ?? {};
  const headers: Record<string, string> = {
    ...safeHeaders,
    "x-admin-token": adminToken,
    "x-requested-by": "automation",
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

/** Safe env vars allowlisted for shell automation actions. */
const SHELL_SAFE_ENV_KEYS = [
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "NODE_ENV",
  "OP_HOME",
];

/** Execute a shell action — uses execFile with argument array (no shell interpolation). */
function executeShellAction(action: AutomationAction): Promise<void> {
  const cmd = action.command!;

  // Build a minimal env from the allowlist — never leak secrets to shell commands
  const safeEnv: Record<string, string> = {};
  for (const key of SHELL_SAFE_ENV_KEYS) {
    if (process.env[key]) safeEnv[key] = process.env[key]!;
  }

  return new Promise((resolve, reject) => {
    execFile(
      cmd[0],
      cmd.slice(1),
      { env: safeEnv, timeout: action.timeout ?? 30_000 },
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

/**
 * Execute an assistant action — creates an OpenCode session and sends the
 * prompt directly via the OpenCode REST API (no guardian needed).
 */
async function executeAssistantAction(action: AutomationAction): Promise<void> {
  if (!action.content) {
    throw new Error("assistant action requires a non-empty 'content' field");
  }

  const baseUrl = process.env.OPENCODE_API_URL ?? "http://localhost:4096";
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (password) {
    headers["authorization"] = `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
  }

  // Create session
  const sessionRes = await fetch(`${baseUrl}/session`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ title: `automation/${action.agent ?? "default"}` }),
  });
  if (!sessionRes.ok) {
    const body = await sessionRes.text().catch(() => "");
    throw new Error(`OpenCode POST /session ${sessionRes.status}: ${body}`);
  }
  const { id: sessionId } = (await sessionRes.json()) as { id: string };
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error("Invalid session ID from assistant");
  }

  // Send message
  const msgRes = await fetch(`${baseUrl}/session/${sessionId}/message`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(action.timeout ?? 120_000),
    body: JSON.stringify({ parts: [{ type: "text", text: action.content }] }),
  });
  if (!msgRes.ok) {
    const body = await msgRes.text().catch(() => "");
    throw new Error(`OpenCode POST /session/${sessionId}/message ${msgRes.status}: ${body}`);
  }
  logger.info("assistant action completed");
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
    case "assistant":
      return executeAssistantAction(action);
  }
}

// ── Scheduler Lifecycle ───────────────────────────────────────────────

let activeJobs: ActiveJob[] = [];

/**
 * Start the in-process scheduler. Reads automations from config/automations/,
 * creates Croner jobs for each enabled one.
 */
export function startScheduler(configDir: string, adminToken: string): void {
  const configs = loadAutomations(configDir);
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
export function reloadScheduler(configDir: string, adminToken: string): void {
  stopScheduler();
  startScheduler(configDir, adminToken);
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
