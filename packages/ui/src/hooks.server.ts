/**
 * SvelteKit server hooks — runs once on admin startup.
 *
 * Performs an idempotent auto-apply: ensures home dirs exist, seeds
 * secrets and OpenCode config, and resolves runtime files. Outcomes are
 * surfaced via the application logger; OpenCode session logs + the
 * guardian's own guardian-audit.log are the audit trail (D6a in
 * docs/technical/auth-and-proxy-refactor-plan.md).
 *
 * Also enforces SEC-1: Host header allowlist to prevent DNS rebinding attacks.
 */
import type { Handle } from "@sveltejs/kit";
import { redirect } from "@sveltejs/kit";
import { getState } from "$lib/server/state.js";
import { checkHostHeader, checkOriginHeader, UI_PORT, identifyCallerByToken } from "$lib/server/helpers.js";
import { touchSession } from "$lib/server/session-store.js";
import { sessionCookieHeader, SESSION_COOKIE_NAME } from "$lib/server/session-cookie.js";
import {
  createLogger,
  composePs,
  deriveLaunchStatus,
  deriveLocalStackState,
  ensureSecrets,
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  resolveRuntimeFiles,
  writeRuntimeFiles,
  ensureHomeDirs,
  isSetupComplete,
  resolveStackDir,
  readStackRuntimeEnv,
  readSecret,
  classifyLocalInstall,
  detectRuntime,
  buildComposeOptions,
  collectBindAddressWarnings,
  type ComposeServiceStatus,
} from "@openpalm/lib";
import { listRemoteStatuses } from "$lib/server/endpoints.js";

const logger = createLogger("admin");

let startupApplyDone = false;
let setupCompleteMemo = false;
type LaunchRouting = {
  installState: ReturnType<typeof classifyLocalInstall>;
  launch: ReturnType<typeof deriveLaunchStatus>;
};

let localStatusCache: { expiresAt: number; value: LaunchRouting } | null = null;

function runStartupApply(): void {
  if (startupApplyDone) return;
  startupApplyDone = true;

  // Warn early if any bind address is non-loopback.
  for (const line of collectBindAddressWarnings(process.env as Record<string, string>)) {
    logger.warn(line);
  }

  try {
    ensureHomeDirs();
    const state = getState();
    ensureSecrets(state);
    // Fallback for the UI login password: production `openpalm ui serve`
    // (packages/cli/src/lib/ui-server.ts) injects OP_UI_LOGIN_PASSWORD before
    // spawning the UI by reading the `op_ui_login_password` file secret. The
    // raw `vite dev` server has no such launcher, so when the env var is unset
    // read it from the same file secret here (the single source of truth —
    // lib's readSecret). No-op in production since the env var is already set.
    if (!process.env.OP_UI_LOGIN_PASSWORD) {
      const pw = readSecret(state.stackDir, "op_ui_login_password");
      if (pw) process.env.OP_UI_LOGIN_PASSWORD = pw.trimEnd();
    }
    // Promote stack.env values into process.env so lazy reads (OpenCode URL,
    // assistant port) in server modules pick up the correct values.
    const stackVars = readStackRuntimeEnv(state.stackDir);
    for (const [k, v] of Object.entries(stackVars)) {
      if (v && !process.env[k]) process.env[k] = v;
    }
    ensureOpenCodeConfig();
    ensureOpenCodeSystemConfig();
    state.artifacts = resolveRuntimeFiles();
    writeRuntimeFiles(state);

    logger.info("startup auto-apply completed successfully", {
      artifactMeta: state.artifactMeta,
    });
  } catch (err) {
    logger.error("startup auto-apply failed", { error: String(err) });
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
// ── SEC-4: Setup routes are localhost-only until setup is complete ────────
// ── Setup guard: redirect to /setup when first-time setup not complete ───

function isLocalhostAddress(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function parseComposePsServices(stdout: string): ComposeServiceStatus[] {
  const services: ComposeServiceStatus[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      services.push({
        service: String(parsed.Service ?? parsed.Name ?? ''),
        state: String(parsed.State ?? ''),
        health: String(parsed.Health ?? ''),
      });
    } catch {
      continue;
    }
  }
  return services;
}

async function resolveLaunchRouting(): Promise<LaunchRouting> {
  if (localStatusCache && localStatusCache.expiresAt > Date.now()) return localStatusCache.value;
  const state = getState();
  const installState = classifyLocalInstall(state.stackDir);
  const composeResult = await composePs(buildComposeOptions(state));
  const services = composeResult.ok ? parseComposePsServices(composeResult.stdout) : [];
  const localState = deriveLocalStackState(installState, services);
  const launch = deriveLaunchStatus({
    local: {
      state: localState,
      runtime: installState === 'not_installed' ? await detectRuntime() : undefined,
      detail: { installState },
    },
    remotes: await listRemoteStatuses(),
  });
  const value = { installState, launch };
  localStatusCache = { value, expiresAt: Date.now() + 5_000 };
  return value;
}

export const handle: Handle = async ({ event, resolve }) => {
  const hostError = checkHostHeader(event.request, UI_PORT);
  if (hostError) return hostError;
  const originError = checkOriginHeader(event.request, UI_PORT);
  if (originError) return originError;

  const path = event.url.pathname;
  const isSetupPath = SETUP_PATHS.some(p => path === p || path.startsWith(p + "/"));

  // SEC-4: While setup is not yet complete the /setup routes are unauthenticated
  // by design (first-run). Restrict them to the local machine so a remote actor
  // can't race the owner to configure the stack. After setup completes the
  // re-run path at /setup?rerun=1 requires admin auth and this guard is skipped.
  const setupComplete = setupCompleteMemo || isSetupComplete(resolveStackDir());
  if (setupComplete) setupCompleteMemo = true;

  if (isSetupPath && !setupComplete) {
    const clientIp = event.getClientAddress();
    if (!isLocalhostAddress(clientIp)) {
      return new Response(
        JSON.stringify({
          error: "setup_localhost_only",
          message: "Setup is only accessible from the host machine until installation is complete.",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }
  }

  if (!isSetupPath) {
    const { installState, launch } = await resolveLaunchRouting();
    const desiredPath = installState === 'setup_incomplete' && launch.local.state === 'running'
      ? '/splash'
      : launch.recommendedRoute === 'chat'
        ? '/chat'
        : '/splash';
    if (path === '/' || (path !== desiredPath && !path.startsWith('/api/') && !path.startsWith('/proxy/') && !path.startsWith('/login') && !path.startsWith('/health') && !path.startsWith('/guardian/health') && !path.startsWith('/admin') && !path.startsWith('/chat') && !path.startsWith('/splash') && !path.startsWith('/advanced'))) {
      redirect(302, desiredPath);
    }
  }

  // ── Admin auth: resolve the session role once per request, then gate page
  // navigations. This is the single auth boundary for the UI — pages carry no
  // auth code and never flash a login screen, because the server decides before
  // any HTML is sent.
  //
  // Only *document* navigations (GET + `Accept: text/html`) are redirected to
  // /login. API/data requests are left alone: every `/admin/*` endpoint enforces
  // auth itself via requireAdmin() and must return JSON 401, not an HTML 302
  // (browser fetch() sends `Accept: */*`, so it never matches here).
  event.locals.role = identifyCallerByToken(event);

  // ── Sliding renewal: a valid cookie was just resolved to a role, so push its
  // expiry back to a full TTL (in the in-memory store) and re-issue the cookie
  // with a fresh Max-Age. This keeps active operators signed in indefinitely
  // while idle sessions still time out after the TTL. Cheap: one map get+set
  // plus one Set-Cookie header. We capture the renewed value here and attach it
  // to the response after resolve() so it isn't clobbered by the handler.
  let renewedCookie: string | null = null;
  if (event.locals.role === "admin") {
    const cookieHeader = event.request.headers.get("cookie") ?? "";
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
    const renewed = match ? touchSession(match[1]) : false;
    if (renewed) {
      renewedCookie = sessionCookieHeader(renewed, event.request);
    }
  }

  const isAuthPath = path === "/login" || path.startsWith("/login/");
  const wantsHtml =
    event.request.method === "GET" &&
    (event.request.headers.get("accept") ?? "").includes("text/html");
  if (wantsHtml && !event.locals.role && !isSetupPath && !isAuthPath) {
    const redirectTo = path + event.url.search;
    redirect(302, `/login?redirectTo=${encodeURIComponent(redirectTo)}`);
  }

  const response = await resolve(event);
  // Apply the sliding-renewal cookie unless the handler itself already issued an
  // op_session cookie (e.g. logout clears it, or a re-login re-issues it) — in
  // that case the handler's intent wins and we must not stomp it.
  if (renewedCookie) {
    const existing = response.headers.get("set-cookie") ?? "";
    if (!existing.includes(`${SESSION_COOKIE_NAME}=`)) {
      response.headers.append("set-cookie", renewedCookie);
    }
  }
  response.headers.set(
    "X-Frame-Options",
    path === '/admin/akm/health-report' ? 'SAMEORIGIN' : 'DENY',
  );
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
};
