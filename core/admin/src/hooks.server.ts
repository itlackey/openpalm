/**
 * SvelteKit server hooks — runs once on admin startup.
 *
 * Performs an idempotent auto-apply: ensures XDG dirs exist, seeds
 * secrets and OpenCode config, stages artifacts to STATE_HOME, and
 * records the outcome in the audit log. This guarantees that the latest
 * CONFIG_HOME state is synced into the runtime on every admin boot.
 */
import { createLogger } from "@openpalm/lib/shared/logger";
import { getState } from "$lib/server/state.js";
import {
  ensureXdgDirs,
  ensureSecrets,
  ensureOpenCodeConfig,
  stageArtifacts,
  persistArtifacts,
  appendAudit
} from "$lib/server/control-plane.js";

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
    state.artifacts = stageArtifacts(state);
    persistArtifacts(state);

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
