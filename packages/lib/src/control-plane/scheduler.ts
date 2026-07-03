/**
 * Automation scheduler — types and akm CLI integration.
 *
 * Automations are AKM task files at ${stashDir}/tasks/*.yml.
 * Scheduling is handled by the OS cron daemon (via `akm tasks sync`).
 * Execution is handled by `akm tasks run <id>`.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { loadMarkdownTasks, taskToAutomationConfig } from "./markdown-task.js";
import { assertAkmEnvComplete } from "./akm-user-env.js";

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

// ── Execute an automation via akm tasks run ───────────────────────────────

export interface AutomationRunResult {
  ok: boolean;
  status: string;
  error?: string;
}

export async function executeAutomation(
  id: string,
  akmEnv: NodeJS.ProcessEnv,
): Promise<AutomationRunResult> {
  assertAkmEnvComplete(akmEnv); // I-6: never let akm fall back to the global config
  // Strip file suffix if caller passes the full filename.
  const taskId = id.replace(/\.(?:ya?ml|md)$/, "");
  return new Promise((resolve) => {
    execFile(
      "akm",
      ["tasks", "run", taskId],
      { env: { ...process.env, ...akmEnv } },
      (error, _stdout, stderr) => {
        if (error) {
          const msg = stderr?.trim() || error.message;
          logger.warn("akm tasks run failed", { id: taskId, error: msg });
          resolve({ ok: false, status: "failed", error: msg });
        } else {
          resolve({ ok: true, status: "completed" });
        }
      }
    );
  });
}

// ── Sync crontab with knowledge/tasks/*.yml ──────────────────────────────────

export async function syncAutomations(akmEnv: NodeJS.ProcessEnv): Promise<void> {
  assertAkmEnvComplete(akmEnv); // I-6: never let akm fall back to the global config
  return new Promise((resolve, reject) => {
    execFile(
      "akm",
      ["tasks", "sync"],
      { env: { ...process.env, ...akmEnv } },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
        } else {
          resolve();
        }
      }
    );
  });
}

// ── Read akm task execution logs ──────────────────────────────────────────

export function readAutomationLogs(
  id: string,
  dataDir: string,
  limit: number = 50,
): string[] {
  const taskId = id.replace(/\.(?:ya?ml|md)$/, "");
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
