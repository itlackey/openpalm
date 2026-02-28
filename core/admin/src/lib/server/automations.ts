/**
 * OpenPalm Automations — user-configured and system-managed cron jobs.
 *
 * Follows the channel system's discover-stage-consume pattern:
 *   CONFIG_HOME/automations.json  — user-defined jobs (editable)
 *   DATA_HOME/automations.json    — system default jobs (seeded once)
 *   STATE_HOME/artifacts/automations.json — merged runtime view
 *
 * The admin process runs a scheduler loop that ticks every 60 seconds,
 * evaluates cron expressions against the merged job list, and triggers
 * matching jobs on the assistant container via the OpenCode Server API.
 */
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { createLogger } from "@openpalm/lib/shared/logger";
import { parseCron, cronMatches, validateCronExpression, nextCronMatch } from "./cron-parser.js";
import { sendPromptToAssistant } from "./assistant-client.js";
import type { ControlPlaneState } from "./control-plane.js";

// @ts-ignore — raw asset import bundled by Vite at build time
import defaultAutomationsAsset from "$assets/default-automations.json?raw";

const logger = createLogger("automations");

// ── Types ──────────────────────────────────────────────────────────────

/** A single automation job definition */
export type AutomationJob = {
  /** Unique identifier (lowercase alphanumeric + hyphens, 1-63 chars) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Cron expression (5-field: minute hour day-of-month month day-of-week) */
  schedule: string;
  /** The prompt to send to the assistant */
  prompt: string;
  /** Whether this job is enabled */
  enabled: boolean;
  /** Source: "user" for CONFIG_HOME jobs, "system" for DATA_HOME defaults */
  source?: "user" | "system";
  /** Optional description */
  description?: string;
  /** Optional timeout in milliseconds (default: 120000) */
  timeoutMs?: number;
};

/** Shape of the automations.json config file */
export type AutomationsConfig = {
  jobs: AutomationJob[];
};

/** Execution history entry (appended to automation-runs.jsonl) */
export type AutomationRunEntry = {
  at: string;
  jobId: string;
  jobName: string;
  trigger: "scheduled" | "manual";
  sessionId: string | null;
  durationMs: number;
  ok: boolean;
  error?: string;
  /** Truncated response text (first 500 chars) */
  responsePreview?: string;
};

/** Runtime state tracked in ControlPlaneState */
export type AutomationRuntimeState = {
  /** Merged jobs from CONFIG + DATA, read from staged STATE */
  jobs: AutomationJob[];
  /** Recent execution history (in-memory ring buffer) */
  history: AutomationRunEntry[];
  /** Whether the scheduler loop is running */
  schedulerActive: boolean;
  /** Job IDs currently executing to prevent overlapping runs */
  inFlightJobIds: Set<string>;
};

// ── Constants ──────────────────────────────────────────────────────────

const AUTOMATION_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_HISTORY_MEMORY = 200;
const SCHEDULER_TICK_MS = 60_000;
const DEFAULT_JOB_TIMEOUT_MS = 120_000;
const RESPONSE_PREVIEW_MAX = 500;

// ── Validation ─────────────────────────────────────────────────────────

/** Validate a single automation job. Returns error message or null. */
export function validateAutomationJob(
  job: unknown
): { ok: true; job: AutomationJob } | { ok: false; error: string } {
  if (!job || typeof job !== "object") {
    return { ok: false, error: "Job must be an object" };
  }

  const j = job as Record<string, unknown>;

  if (typeof j.id !== "string" || !AUTOMATION_ID_RE.test(j.id)) {
    return { ok: false, error: `Invalid job id: must match ${AUTOMATION_ID_RE}` };
  }
  if (typeof j.name !== "string" || !j.name.trim()) {
    return { ok: false, error: "Job name is required" };
  }
  if (typeof j.schedule !== "string") {
    return { ok: false, error: "Job schedule is required" };
  }
  const cronErr = validateCronExpression(j.schedule);
  if (cronErr) {
    return { ok: false, error: `Invalid cron expression: ${cronErr}` };
  }
  if (typeof j.prompt !== "string" || !j.prompt.trim()) {
    return { ok: false, error: "Job prompt is required" };
  }
  if (typeof j.enabled !== "boolean") {
    return { ok: false, error: "Job enabled must be a boolean" };
  }
  if (j.timeoutMs !== undefined && (typeof j.timeoutMs !== "number" || j.timeoutMs < 1000)) {
    return { ok: false, error: "Job timeoutMs must be a number >= 1000" };
  }
  if (j.description !== undefined && typeof j.description !== "string") {
    return { ok: false, error: "Job description must be a string" };
  }

  return {
    ok: true,
    job: {
      id: j.id,
      name: j.name.trim(),
      schedule: j.schedule,
      prompt: j.prompt,
      enabled: j.enabled,
      description: typeof j.description === "string" ? j.description : undefined,
      timeoutMs: typeof j.timeoutMs === "number" ? j.timeoutMs : undefined,
    },
  };
}

// ── Discovery ──────────────────────────────────────────────────────────

/** Parse an automations.json file. Returns empty array on missing or malformed input. */
function loadAutomationsFile(filePath: string, source: "user" | "system"): AutomationJob[] {
  if (!existsSync(filePath)) return [];

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as AutomationsConfig).jobs)) {
      logger.warn(`Invalid automations config at ${filePath}: expected { jobs: [] }`);
      return [];
    }

    const jobs: AutomationJob[] = [];
    for (const rawJob of (parsed as AutomationsConfig).jobs) {
      const result = validateAutomationJob(rawJob);
      if (result.ok) {
        result.job.source = source;
        jobs.push(result.job);
      } else {
        logger.warn(`Skipping invalid job in ${filePath}: ${result.error}`);
      }
    }
    return jobs;
  } catch (err) {
    logger.warn(`Failed to parse ${filePath}: ${String(err)}`);
    return [];
  }
}

/** Load user-configured jobs from CONFIG_HOME/automations.json. */
export function discoverUserJobs(configDir: string): AutomationJob[] {
  return loadAutomationsFile(`${configDir}/automations.json`, "user");
}

/** Load system default jobs from DATA_HOME/automations.json. */
export function discoverSystemJobs(dataDir: string): AutomationJob[] {
  return loadAutomationsFile(`${dataDir}/automations.json`, "system");
}

/**
 * Merge user + system jobs into a single array.
 * User jobs take precedence by ID — if a user defines a job with the same
 * ID as a system job, the user's version wins.
 */
export function mergeJobs(
  userJobs: AutomationJob[],
  systemJobs: AutomationJob[]
): AutomationJob[] {
  const byId = new Map<string, AutomationJob>();

  // System jobs first (lower precedence)
  for (const job of systemJobs) {
    byId.set(job.id, { ...job, source: "system" });
  }

  // User jobs override by ID
  for (const job of userJobs) {
    byId.set(job.id, { ...job, source: "user" });
  }

  return Array.from(byId.values());
}

// ── Staging ────────────────────────────────────────────────────────────

/**
 * Stage merged automations.json to STATE_HOME/artifacts/automations.json.
 * Called from persistArtifacts() during install/update/apply.
 */
export function stageAutomations(state: ControlPlaneState): void {
  const userJobs = discoverUserJobs(state.configDir);
  const systemJobs = discoverSystemJobs(state.dataDir);
  const merged = mergeJobs(userJobs, systemJobs);

  const artifactDir = `${state.stateDir}/artifacts`;
  mkdirSync(artifactDir, { recursive: true });

  const config: AutomationsConfig = { jobs: merged };
  writeFileSync(`${artifactDir}/automations.json`, JSON.stringify(config, null, 2) + "\n");

  // Update in-memory state so the scheduler picks up changes on next tick
  state.automations.jobs = merged;
}

// ── System Defaults Seeding ────────────────────────────────────────────

/**
 * Seed system default automations to DATA_HOME/automations.json on first install.
 * Only writes if the file doesn't exist (never overwrites).
 */
export function ensureDefaultAutomations(dataDir: string): void {
  const path = `${dataDir}/automations.json`;
  if (existsSync(path)) return;

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, defaultAutomationsAsset);
}

// ── User Config CRUD ───────────────────────────────────────────────────

/** Read the user's automations.json from CONFIG_HOME. Returns parsed config. */
export function readUserAutomationsConfig(configDir: string): AutomationsConfig {
  const path = `${configDir}/automations.json`;
  if (!existsSync(path)) return { jobs: [] };

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as AutomationsConfig).jobs)) {
      return parsed as AutomationsConfig;
    }
  } catch {
    // malformed file — treat as empty
  }
  return { jobs: [] };
}

/** Write the user's automations.json to CONFIG_HOME. */
export function writeUserAutomationsConfig(configDir: string, config: AutomationsConfig): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(`${configDir}/automations.json`, JSON.stringify(config, null, 2) + "\n");
}

/** Add a job to the user's CONFIG_HOME/automations.json. Returns error or null. */
export function addUserJob(configDir: string, job: AutomationJob): string | null {
  const config = readUserAutomationsConfig(configDir);
  if (config.jobs.some((j) => j.id === job.id)) {
    return `Job with id "${job.id}" already exists`;
  }
  config.jobs.push({ ...job, source: undefined });
  writeUserAutomationsConfig(configDir, config);
  return null;
}

/** Update a job in the user's CONFIG_HOME/automations.json. Returns error or null. */
export function updateUserJob(
  configDir: string,
  id: string,
  updates: Partial<AutomationJob>
): string | null {
  const config = readUserAutomationsConfig(configDir);
  const idx = config.jobs.findIndex((j) => j.id === id);
  if (idx === -1) {
    return `Job "${id}" not found in user config`;
  }
  const existing = config.jobs[idx];
  config.jobs[idx] = {
    ...existing,
    ...updates,
    id: existing.id, // id is immutable
    source: undefined, // never written to file
  };
  writeUserAutomationsConfig(configDir, config);
  return null;
}

/** Remove a job from the user's CONFIG_HOME/automations.json. Returns error or null. */
export function removeUserJob(configDir: string, id: string): string | null {
  const config = readUserAutomationsConfig(configDir);
  const idx = config.jobs.findIndex((j) => j.id === id);
  if (idx === -1) {
    return `Job "${id}" not found in user config`;
  }
  config.jobs.splice(idx, 1);
  writeUserAutomationsConfig(configDir, config);
  return null;
}

/**
 * Create or update an override entry in CONFIG_HOME/automations.json for a system job.
 * Used when the user wants to disable/enable a system-managed job without
 * modifying DATA_HOME/automations.json.
 */
export function overrideSystemJob(
  configDir: string,
  dataDir: string,
  id: string,
  overrides: Partial<AutomationJob>
): string | null {
  // Verify the job exists in system defaults
  const systemJobs = discoverSystemJobs(dataDir);
  const systemJob = systemJobs.find((j) => j.id === id);
  if (!systemJob) {
    return `System job "${id}" not found`;
  }

  const config = readUserAutomationsConfig(configDir);
  const idx = config.jobs.findIndex((j) => j.id === id);

  if (idx !== -1) {
    // Update existing override
    config.jobs[idx] = {
      ...config.jobs[idx],
      ...overrides,
      id, // id is immutable
      source: undefined,
    };
  } else {
    // Create new override based on system job
    config.jobs.push({
      ...systemJob,
      ...overrides,
      id,
      source: undefined,
    });
  }

  writeUserAutomationsConfig(configDir, config);
  return null;
}

// ── Execution ──────────────────────────────────────────────────────────

/**
 * Execute a single job immediately.
 * Used by both the scheduler and the manual trigger endpoint.
 */
export async function executeJob(
  state: ControlPlaneState,
  job: AutomationJob,
  trigger: "scheduled" | "manual"
): Promise<AutomationRunEntry> {
  const start = new Date();

  const result = await sendPromptToAssistant(job.prompt, {
    title: `automation/${job.id}`,
    timeoutMs: job.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
  });

  const entry: AutomationRunEntry = {
    at: start.toISOString(),
    jobId: job.id,
    jobName: job.name,
    trigger,
    sessionId: result.sessionId,
    durationMs: result.durationMs,
    ok: result.ok,
    error: result.error,
    responsePreview: result.text
      ? result.text.slice(0, RESPONSE_PREVIEW_MAX)
      : undefined,
  };

  // Append to in-memory history
  state.automations.history.push(entry);
  if (state.automations.history.length > MAX_HISTORY_MEMORY) {
    state.automations.history = state.automations.history.slice(-MAX_HISTORY_MEMORY);
  }

  // Append to audit file
  try {
    const auditDir = `${state.stateDir}/audit`;
    mkdirSync(auditDir, { recursive: true });
    appendFileSync(
      `${auditDir}/automation-runs.jsonl`,
      JSON.stringify(entry) + "\n"
    );
  } catch {
    // best-effort persistence
  }

  return entry;
}

// ── Scheduler ──────────────────────────────────────────────────────────

/**
 * Start the automation scheduler.
 * Ticks every 60 seconds aligned to the minute boundary.
 * On each tick, evaluates enabled jobs and executes matches.
 */
export function startScheduler(state: ControlPlaneState): { stop: () => void } {
  state.automations.schedulerActive = true;

  // Align to the next minute boundary
  const now = new Date();
  const seconds = now.getSeconds();
  const millis = now.getMilliseconds();
  const msUntilNextMinute =
    // If already exactly on a minute boundary, tick immediately.
    seconds === 0 && millis === 0
      ? 0
      : (60 - seconds) * 1000 - millis;

  let intervalId: ReturnType<typeof setInterval> | null = null;

  const tick = async () => {
    if (!state.automations.schedulerActive) return;

    const tickTime = new Date();
    // Floor to the start of the current minute
    tickTime.setSeconds(0, 0);

    // Check if assistant is running
    if (state.services.assistant !== "running") {
      return;
    }

    const enabledJobs = state.automations.jobs.filter((j) => j.enabled);
    const matchingJobs: AutomationJob[] = [];

    for (const job of enabledJobs) {
      try {
        const fields = parseCron(job.schedule);
        if (cronMatches(fields, tickTime)) {
          matchingJobs.push(job);
        }
      } catch (err) {
        logger.warn(`Invalid cron expression for job "${job.id}": ${String(err)}`);
      }
    }

    const runnableJobs = matchingJobs.filter((job) => {
      if (state.automations.inFlightJobIds.has(job.id)) {
        logger.warn(`Skipping overlapping automation run for "${job.id}"`);
        return false;
      }
      return true;
    });

    if (runnableJobs.length === 0) return;

    logger.info(`Executing ${runnableJobs.length} scheduled automation(s)`, {
      jobs: runnableJobs.map((j) => j.id),
    });

    // Execute matching jobs concurrently
    const results = await Promise.allSettled(
      runnableJobs.map(async (job) => {
        state.automations.inFlightJobIds.add(job.id);
        try {
          return await executeJob(state, job, "scheduled");
        } finally {
          state.automations.inFlightJobIds.delete(job.id);
        }
      })
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const job = runnableJobs[i];
      if (result.status === "rejected") {
        logger.error(`Automation "${job.id}" failed unexpectedly`, {
          error: String(result.reason),
        });
      } else if (!result.value.ok) {
        logger.warn(`Automation "${job.id}" completed with error`, {
          error: result.value.error,
        });
      }
    }
  };

  // Start with initial delay to align to minute boundary, then tick every 60s
  const initialTimeout = setTimeout(() => {
    tick();
    intervalId = setInterval(tick, SCHEDULER_TICK_MS);
  }, msUntilNextMinute);

  logger.info("Automation scheduler started", {
    jobCount: state.automations.jobs.length,
    enabledCount: state.automations.jobs.filter((j) => j.enabled).length,
    nextTickIn: `${Math.round(msUntilNextMinute / 1000)}s`,
  });

  return {
    stop: () => {
      state.automations.schedulerActive = false;
      clearTimeout(initialTimeout);
      if (intervalId) clearInterval(intervalId);
      logger.info("Automation scheduler stopped");
    },
  };
}

// ── Query Helpers ──────────────────────────────────────────────────────

/** Get the next run time for a job. Returns ISO string or null. */
export function getNextRunTime(job: AutomationJob): string | null {
  if (!job.enabled) return null;
  try {
    const fields = parseCron(job.schedule);
    const next = nextCronMatch(fields, new Date());
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

/** Get next run times for all jobs. Returns map of jobId → ISO string. */
export function getNextRunTimes(jobs: AutomationJob[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const job of jobs) {
    const next = getNextRunTime(job);
    if (next) result[job.id] = next;
  }
  return result;
}
