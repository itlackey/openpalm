/**
 * Automation scheduler — loads automations from config/automations/,
 * schedules them with Croner, watches for filesystem changes.
 *
 * Re-uses parsing and loading logic from @openpalm/lib. Action execution
 * is handled by the sidecar's own action executors (with configurable URLs).
 */
import { Cron } from "croner";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import {
  loadAutomations,
  createLogger,
  type AutomationConfig,
  type ExecutionLogEntry,
} from "@openpalm/lib";
import { executeAction } from "./actions/index.js";

const logger = createLogger("scheduler");

// ── Execution Log (in-memory ring buffer) ─────────────────────────────

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

// ── Active Jobs ──────────────────────────────────────────────────────

type ActiveJob = {
  cron: Cron;
  config: AutomationConfig;
};

let activeJobs: ActiveJob[] = [];
let watcher: FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

// ── Scheduler Lifecycle ──────────────────────────────────────────────

/** Start the scheduler. Reads automations and creates Croner jobs. */
export function startScheduler(configDir: string, adminToken: string): void {
  const configs = loadAutomations(configDir);
  const enabled = configs.filter((c) => c.enabled);

  for (const config of enabled) {
    try {
      const cron = new Cron(
        config.schedule,
        { timezone: config.timezone, protect: true },
        async () => {
          const start = Date.now();
          try {
            await executeAction(config.action, adminToken);
            const durationMs = Date.now() - start;
            recordExecution(config.fileName, {
              at: new Date().toISOString(),
              ok: true,
              durationMs,
            });
            logger.info("automation executed", {
              name: config.name,
              fileName: config.fileName,
              durationMs,
            });
          } catch (err) {
            const durationMs = Date.now() - start;
            const errorMsg = String(err);
            recordExecution(config.fileName, {
              at: new Date().toISOString(),
              ok: false,
              durationMs,
              error: errorMsg,
            });
            logger.error("automation failed", {
              name: config.name,
              fileName: config.fileName,
              error: errorMsg,
            });
          }
        },
      );

      activeJobs.push({ cron, config });
    } catch (err) {
      logger.error("failed to schedule automation", {
        name: config.name,
        fileName: config.fileName,
        schedule: config.schedule,
        error: String(err),
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

/** Reload: stop all jobs, then start fresh from disk. */
export function reloadScheduler(configDir: string, adminToken: string): void {
  stopScheduler();
  startScheduler(configDir, adminToken);
}

/** Return current scheduler status. */
export function getSchedulerStatus(): {
  jobCount: number;
  jobs: Array<{
    name: string;
    fileName: string;
    schedule: string;
    nextRun: string | null;
    running: boolean;
  }>;
} {
  return {
    jobCount: activeJobs.length,
    jobs: activeJobs.map((j) => ({
      name: j.config.name,
      fileName: j.config.fileName,
      schedule: j.config.schedule,
      nextRun: j.cron.nextRun()?.toISOString() ?? null,
      running: j.cron.isRunning(),
    })),
  };
}

/** Get loaded automation configs (for listing via API). */
export function getLoadedAutomations(): AutomationConfig[] {
  return activeJobs.map((j) => j.config);
}

/** Manually trigger an automation by fileName. */
export async function triggerAutomation(
  fileName: string,
  adminToken: string,
): Promise<{ ok: boolean; error?: string }> {
  const job = activeJobs.find((j) => j.config.fileName === fileName);
  if (!job) {
    return { ok: false, error: `automation not found: ${fileName}` };
  }

  const start = Date.now();
  try {
    await executeAction(job.config.action, adminToken);
    const durationMs = Date.now() - start;
    recordExecution(fileName, {
      at: new Date().toISOString(),
      ok: true,
      durationMs,
    });
    logger.info("automation manually triggered", {
      name: job.config.name,
      fileName,
      durationMs,
    });
    return { ok: true };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMsg = String(err);
    recordExecution(fileName, {
      at: new Date().toISOString(),
      ok: false,
      durationMs,
      error: errorMsg,
    });
    return { ok: false, error: errorMsg };
  }
}

// ── File Watching ────────────────────────────────────────────────────

/**
 * Start watching config/automations/ for changes.
 * Debounces reloads to avoid thrashing on rapid writes.
 */
export function startWatching(configDir: string, adminToken: string): void {
  const dir = join(configDir, "automations");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  try {
    watcher = watch(dir, (_eventType, filename) => {
      if (!filename?.endsWith(".yml")) return;

      // Debounce — wait 500ms after last change before reloading
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        logger.info("automation files changed, reloading", { trigger: filename });
        reloadScheduler(configDir, adminToken);
        reloadTimer = null;
      }, 500);
    });

    logger.info("watching for automation file changes", { dir });
  } catch (err) {
    logger.warn("file watching not available, using polling fallback", {
      error: String(err),
    });
    startPolling(configDir, adminToken);
  }
}

/** Polling fallback when fs.watch is unavailable. */
let pollInterval: ReturnType<typeof setInterval> | null = null;
let lastFileList = "";

function startPolling(configDir: string, adminToken: string): void {
  const dir = join(configDir, "automations");
  const POLL_INTERVAL_MS = 10_000;

  pollInterval = setInterval(() => {
    try {
      if (!existsSync(dir)) return;
      const files = readdirSync(dir).sort().join("\n");
      if (files !== lastFileList) {
        lastFileList = files;
        logger.info("automation files changed (poll), reloading");
        reloadScheduler(configDir, adminToken);
      }
    } catch {
      // Ignore polling errors
    }
  }, POLL_INTERVAL_MS);
}

/** Stop watching for changes. */
export function stopWatching(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
