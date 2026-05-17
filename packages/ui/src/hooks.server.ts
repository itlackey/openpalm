/**
 * SvelteKit server hooks — runs once on admin startup.
 *
 * Performs an idempotent auto-apply: ensures home dirs exist, seeds
 * secrets and OpenCode config, resolves runtime files, and records
 * the outcome in the audit log.
 *
 * Also enforces SEC-1: Host header allowlist to prevent DNS rebinding attacks.
 */
import type { Handle } from "@sveltejs/kit";
import { redirect } from "@sveltejs/kit";
import { getState } from "$lib/server/state.js";
import { checkHostHeader, checkOriginHeader, ADMIN_PORT } from "$lib/server/helpers.js";
import {
  createLogger,
  ensureSecrets,
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  resolveRuntimeFiles,
  writeRuntimeFiles,
  appendAudit,
  ensureHomeDirs,
  isSetupComplete,
  resolveStackDir,
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

// Paths exempt from the setup guard (setup UI itself + health probes)
const SETUP_PATHS = ["/setup", "/api/setup", "/health", "/guardian/health"];

// ── SEC-1: Host header allowlist (DNS rebinding protection) ──────────────
// ── SEC-2: Origin check for state-mutating requests (CSRF protection) ────
// ── Setup guard: redirect to /setup when first-time setup not complete ───
export const handle: Handle = async ({ event, resolve }) => {
  const hostError = checkHostHeader(event.request, ADMIN_PORT);
  if (hostError) return hostError;
  const originError = checkOriginHeader(event.request, ADMIN_PORT);
  if (originError) return originError;

  const path = event.url.pathname;
  const isSetupPath = SETUP_PATHS.some(p => path === p || path.startsWith(p + "/"));
  if (!isSetupPath && !isSetupComplete(resolveStackDir())) {
    redirect(302, "/setup");
  }

  return resolve(event);
};
