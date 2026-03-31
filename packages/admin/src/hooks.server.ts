/**
 * SvelteKit server hooks — runs once on admin startup.
 *
 * Performs an idempotent auto-apply: ensures home dirs exist, seeds
 * secrets and OpenCode config, resolves runtime files, and records
 * the outcome in the audit log.
 */
import { createLogger } from "$lib/server/logger.js";
import { getState } from "$lib/server/state.js";
import {
  ensureSecrets,
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  ensureMemoryDir,
  ensureUserEnvSchema,
  ensureSystemEnvSchema,
  resolveRuntimeFiles,
  writeRuntimeFiles,
  appendAudit,
  ensureHomeDirs,
} from "@openpalm/lib";

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
    ensureUserEnvSchema();
    ensureSystemEnvSchema();
    state.artifacts = resolveRuntimeFiles();
    writeRuntimeFiles(state);

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

// Run immediately on module load (server startup)
runStartupApply();

// Scheduler is now a dedicated sidecar — admin has zero background processes.
