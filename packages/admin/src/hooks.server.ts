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
  ensureSecrets,
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  ensureMemoryDir,
  ensureCoreAutomations,
  ensureUserEnvSchema,
  ensureSystemEnvSchema,
  resolveArtifacts,
  persistConfiguration,
  appendAudit,
  readMemoryConfig,
  resolveConfigForPush,
  pushConfigToMemory
} from "$lib/server/control-plane.js";
import { ensureHomeDirs } from "@openpalm/lib";

const logger = createLogger("admin");

let startupApplyDone = false;

function runStartupApply(): void {
  if (startupApplyDone) return;
  startupApplyDone = true;

  try {
    ensureHomeDirs();
    const state = getState();
    ensureSecrets(state);
    ensureOpenCodeConfig();
    ensureOpenCodeSystemConfig();
    ensureMemoryDir();
    ensureCoreAutomations();
    ensureUserEnvSchema();
    ensureSystemEnvSchema();
    state.artifacts = resolveArtifacts(state);
    persistConfiguration(state);

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
 * Push the persisted memory config to the running container.
 * Retries up to 5 times with 10s delays — the memory service may still be starting.
 * Fire-and-forget: failures are logged but don't block admin startup.
 */
async function pushMemoryConfigOnStartup(): Promise<void> {
  const state = getState();
  const config = readMemoryConfig(state.dataDir);
  const resolved = resolveConfigForPush(config, state.configDir);

  const maxAttempts = 5;
  const delayMs = 10_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await pushConfigToMemory(resolved);
    if (result.ok) {
      logger.info("pushed memory config on startup", { attempt });
      return;
    }
    if (attempt < maxAttempts) {
      logger.debug("memory config push attempt failed, retrying", {
        attempt,
        error: result.error
      });
      await new Promise((r) => setTimeout(r, delayMs));
    } else {
      logger.warn("failed to push memory config after all retries", {
        attempts: maxAttempts,
        error: result.error
      });
    }
  }
}

// Run immediately on module load (server startup)
runStartupApply();

// Fire-and-forget: push memory config after startup apply
void pushMemoryConfigOnStartup();

// Scheduler is now a dedicated sidecar — admin has zero background processes.
