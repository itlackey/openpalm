/**
 * SvelteKit server hooks — runs once on admin startup.
 *
 * Performs an idempotent auto-apply: ensures XDG dirs exist, seeds
 * secrets and OpenCode config, stages artifacts to STATE_HOME, and
 * records the outcome in the audit log. This guarantees that the latest
 * CONFIG_HOME state is synced into the runtime on every admin boot.
 */
import { createLogger } from "$lib/server/logger.js";
import { getState } from "$lib/server/state.js";
import {
  ensureXdgDirs,
  ensureSecrets,
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  ensureOpenMemoryDir,
  stageArtifacts,
  persistArtifacts,
  appendAudit,
  readOpenMemoryConfig,
  resolveConfigForPush,
  pushConfigToOpenMemory
} from "$lib/server/control-plane.js";
import { startScheduler, stopScheduler } from "$lib/server/scheduler.js";

const logger = createLogger("admin");

let startupApplyDone = false;

function runStartupApply(): void {
  if (startupApplyDone) return;
  startupApplyDone = true;

  try {
    ensureXdgDirs();
    const state = getState();
    ensureSecrets(state);
    ensureOpenCodeConfig();
    ensureOpenCodeSystemConfig();
    ensureOpenMemoryDir();
    state.artifacts = stageArtifacts(state);
    persistArtifacts(state);

    startScheduler(state.stateDir, state.adminToken);

    appendAudit(
      state,
      "system",
      "startup.apply",
      {
        result: "ok",
        artifactMeta: state.artifactMeta
      },
      true,
      "",
      "system"
    );
    logger.info("startup auto-apply completed successfully");
  } catch (err) {
    logger.error("startup auto-apply failed", { error: String(err) });
    try {
      const state = getState();
      appendAudit(
        state,
        "system",
        "startup.apply",
        { result: "error", error: String(err) },
        false,
        "",
        "system"
      );
    } catch (auditErr) {
      logger.error("failed to record startup failure in audit", { error: String(auditErr) });
    }
  }
}

/**
 * Push the persisted OpenMemory config to the running container.
 * Retries up to 5 times with 10s delays — OpenMemory may still be starting.
 * Fire-and-forget: failures are logged but don't block admin startup.
 */
async function pushOpenMemoryConfigOnStartup(): Promise<void> {
  const state = getState();
  const config = readOpenMemoryConfig(state.dataDir);
  const resolved = resolveConfigForPush(config, state.configDir);

  const maxAttempts = 5;
  const delayMs = 10_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await pushConfigToOpenMemory(resolved);
    if (result.ok) {
      logger.info("pushed OpenMemory config on startup", { attempt });
      return;
    }
    if (attempt < maxAttempts) {
      logger.debug("OpenMemory config push attempt failed, retrying", {
        attempt,
        error: result.error
      });
      await new Promise((r) => setTimeout(r, delayMs));
    } else {
      logger.warn("failed to push OpenMemory config after all retries", {
        attempts: maxAttempts,
        error: result.error
      });
    }
  }
}

// Run immediately on module load (server startup)
runStartupApply();

// Fire-and-forget: push OpenMemory config after startup apply
void pushOpenMemoryConfigOnStartup();

// Graceful shutdown — stop scheduled jobs
process.on("SIGTERM", () => { stopScheduler(); });
process.on("SIGINT", () => { stopScheduler(); });
