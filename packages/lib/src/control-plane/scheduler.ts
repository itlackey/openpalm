/** Automation scheduler — types, parsing, and action execution. */
import { parse as parseYaml } from "yaml";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const logger = createLogger("scheduler");


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

export type ExecutionLogEntry = {
  at: string;
  ok: boolean;
  durationMs: number;
  error?: string;
};


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

/** Resolve a preset name to cron expression, or pass through raw cron. */
export function resolveSchedule(schedule: string): string {
  return SCHEDULE_PRESETS[schedule] ?? schedule;
}

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

  const rawSchedule = doc.schedule;
  if (typeof rawSchedule !== "string" || !rawSchedule.trim()) {
    logger.warn("automation missing or empty 'schedule'", { fileName });
    return null;
  }

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
      headers: (actionObj.headers && typeof actionObj.headers === "object" && !Array.isArray(actionObj.headers) &&
        Object.values(actionObj.headers as Record<string, unknown>).every((v) => typeof v === "string"))
        ? (actionObj.headers as Record<string, string>) : undefined,
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


export const SAFE_PATH_RE = /^\/admin\/[a-zA-Z0-9/._-]+$/;

export async function executeApiAction(
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

export async function executeHttpAction(action: AutomationAction): Promise<void> {
  if (!action.url) throw new Error("http action requires a url");
  const headers: Record<string, string> = { ...action.headers };
  if (action.body) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), action.timeout ?? 30_000);
  try {
    const resp = await fetch(action.url, {
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

const SHELL_SAFE_ENV_KEYS = [
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "NODE_ENV",
  "OP_HOME",
];

export function executeShellAction(action: AutomationAction): Promise<void> {
  if (!action.command?.length) throw new Error("shell action requires a non-empty command array");
  const cmd = action.command;

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

export async function executeAssistantAction(action: AutomationAction): Promise<void> {
  if (!action.content) {
    throw new Error("assistant action requires a non-empty 'content' field");
  }

  const baseUrl = process.env.OPENCODE_API_URL ?? "http://assistant:4096";
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (password) {
    headers["authorization"] = `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
  }

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
