/**
 * OpenPalm Scheduler — automation co-process.
 *
 * Runs alongside the assistant (OpenCode) inside the assistant container.
 * Does NOT expose any network port. The control plane is purely filesystem-
 * driven:
 *
 *   ${OP_HOME}/config/automations/*.yml         — automation definitions
 *   ${OP_HOME}/data/scheduler/triggers/<file>.run — manual trigger sentinels
 *
 * Drop a `<fileName>.run` file (any content) into the triggers directory to
 * fire the named automation once; the sentinel is removed after the run
 * starts (success or failure is recorded in the in-memory execution log).
 *
 * Library exports (croner status / execution log / manual trigger) remain
 * available for in-process callers via `./scheduler.js`.
 */
import { existsSync, mkdirSync, readdirSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@openpalm/lib";
import {
  startScheduler,
  stopScheduler,
  startWatching,
  stopWatching,
  triggerAutomation,
  getSchedulerStatus,
} from "./scheduler.js";

const logger = createLogger("scheduler:server");

const OP_HOME = process.env.OP_HOME ?? "";
const CONFIG_DIR = OP_HOME ? join(OP_HOME, "config") : "";
// Scheduler runs inside the assistant container; admin API calls authenticate
// with the assistant's operational token (OP_ASSISTANT_TOKEN). No dedicated
// admin↔scheduler token exists anymore.
const ADMIN_TOKEN = process.env.OP_ASSISTANT_TOKEN ?? "";
const TRIGGERS_DIR = OP_HOME ? join(OP_HOME, "data", "scheduler", "triggers") : "";

if (!CONFIG_DIR || !TRIGGERS_DIR) {
  logger.error("OP_HOME is required");
  process.exit(1);
}

if (!ADMIN_TOKEN) {
  logger.warn(
    "OP_ASSISTANT_TOKEN is not set — `api` automations that call the admin API will fail",
  );
}

// ── Manual-trigger sentinel watcher ───────────────────────────────────
// Filenames are matched against the loaded automation `fileName` (e.g.
// `daily-summary.yml.run`). The `.run` suffix is stripped before lookup.
// Sentinels are deleted as soon as they are observed, so a long-running
// automation doesn't fire twice from the same file.

const TRIGGER_SUFFIX = ".run";
let triggerWatcher: FSWatcher | null = null;
const inFlightTriggers = new Set<string>();

function ensureTriggersDir(): void {
  if (!existsSync(TRIGGERS_DIR)) {
    mkdirSync(TRIGGERS_DIR, { recursive: true });
  }
}

async function processTriggerFile(fileName: string): Promise<void> {
  if (!fileName.endsWith(TRIGGER_SUFFIX)) return;
  const automationFile = fileName.slice(0, -TRIGGER_SUFFIX.length);
  if (!automationFile) return;

  const sentinelPath = join(TRIGGERS_DIR, fileName);
  if (!existsSync(sentinelPath)) return;

  // De-dupe — fs.watch can fire multiple events for a single sentinel.
  if (inFlightTriggers.has(fileName)) return;
  inFlightTriggers.add(fileName);

  // Remove the sentinel first so a slow automation doesn't re-fire from
  // late-arriving watch events.
  try {
    unlinkSync(sentinelPath);
  } catch (err) {
    // If we couldn't unlink, refuse to fire — another process may handle it.
    logger.warn("failed to remove trigger sentinel; skipping fire", {
      fileName,
      error: String(err),
    });
    inFlightTriggers.delete(fileName);
    return;
  }

  logger.info("manual trigger received", { sentinel: fileName, automation: automationFile });

  try {
    const result = await triggerAutomation(automationFile, ADMIN_TOKEN);
    if (!result.ok) {
      logger.warn("manual trigger failed", { automation: automationFile, error: result.error });
    }
  } catch (err) {
    logger.error("manual trigger threw", { automation: automationFile, error: String(err) });
  } finally {
    inFlightTriggers.delete(fileName);
  }
}

function scanExistingTriggers(): void {
  let entries: string[];
  try {
    entries = readdirSync(TRIGGERS_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.endsWith(TRIGGER_SUFFIX)) {
      void processTriggerFile(entry);
    }
  }
}

function startTriggerWatcher(): void {
  ensureTriggersDir();
  try {
    triggerWatcher = watch(TRIGGERS_DIR, (_eventType, filename) => {
      if (!filename) return;
      void processTriggerFile(filename);
    });
    logger.info("watching for manual trigger sentinels", { dir: TRIGGERS_DIR });
  } catch (err) {
    logger.warn("trigger watcher unavailable, falling back to polling", {
      error: String(err),
    });
    startTriggerPolling();
  }

  // Pick up any sentinels that already exist (e.g. dropped before the
  // scheduler started).
  scanExistingTriggers();
}

let triggerPollInterval: ReturnType<typeof setInterval> | null = null;
function startTriggerPolling(): void {
  const POLL_INTERVAL_MS = 2_000;
  triggerPollInterval = setInterval(scanExistingTriggers, POLL_INTERVAL_MS);
}

function stopTriggerWatcher(): void {
  if (triggerWatcher) {
    triggerWatcher.close();
    triggerWatcher = null;
  }
  if (triggerPollInterval) {
    clearInterval(triggerPollInterval);
    triggerPollInterval = null;
  }
}

// ── Startup ──────────────────────────────────────────────────────────

logger.info("starting scheduler co-process", {
  configDir: CONFIG_DIR,
  triggersDir: TRIGGERS_DIR,
});

startScheduler(CONFIG_DIR, ADMIN_TOKEN);
startWatching(CONFIG_DIR, ADMIN_TOKEN);
startTriggerWatcher();

const status = getSchedulerStatus();
logger.info(`scheduler running with ${status.jobCount} automation(s)`);

// ── Graceful shutdown ────────────────────────────────────────────────

function shutdown(): void {
  logger.info("shutting down scheduler");
  stopTriggerWatcher();
  stopWatching();
  stopScheduler();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
