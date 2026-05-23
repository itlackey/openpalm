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
  readStackEnv,
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
    // Promote stack.env values into process.env so lazy reads (OpenCode URL,
    // assistant port) in server modules pick up the correct values.
    const stackVars = readStackEnv(state.stackDir);
    for (const [k, v] of Object.entries(stackVars)) {
      if (v && !process.env[k]) process.env[k] = v;
    }
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

// ── SEC-3: Security headers (XSS / clickjacking / MIME-sniffing) ─────────
// The main CSP is emitted by SvelteKit itself via `kit.csp` in
// svelte.config.js — `mode: 'hash'` auto-hashes the inline hydration scripts
// so `script-src 'self'` doesn't break SvelteKit's bootstrap. SvelteKit
// inlines the policy as a <meta> tag in the SSR HTML.
//
// Three directives can't be set via <meta> per the CSP spec
// (`frame-ancestors`, `report-uri`, `sandbox`). We back `frame-ancestors
// 'none'` with the legacy `X-Frame-Options: DENY` header, which is
// universally enforced.
//
// `X-Content-Type-Options: nosniff` prevents MIME-sniffing-based XSS where
// a user-uploaded or proxied file is interpreted as HTML/JS.
//
// `Referrer-Policy: no-referrer` keeps URLs from leaking to third-party
// origins (admin paths, request IDs).

// ── SEC-1: Host header allowlist (DNS rebinding protection) ──────────────
// ── SEC-2: Origin check for state-mutating requests (CSRF protection) ────
// ── SEC-3: Security headers (see above) ──────────────────────────────────
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

  const response = await resolve(event);
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
};
