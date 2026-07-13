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
import { checkHostHeader, checkOriginHeader, getRequestId, identifyCallerByToken } from "$lib/server/helpers.js";
import { touchSession } from "$lib/server/session-store.js";
import { sessionCookieHeader, SESSION_COOKIE_NAME } from "$lib/server/session-cookie.js";
import { computeServerRuntimeContext } from '$lib/server/features.js';
import {
  createLogger,
  isSetupComplete,
  resolveOpenPalmHome,
  readStackRuntimeEnv,
  readSecret,
  collectNetworkExposureWarnings,
  isRemoteSetupAllowed,
  stackDirFor,
  reconcileMdnsResponder,
} from "@openpalm/lib";
import { resolveRequestLanding, getCachedLocalInstallState } from "$lib/server/landing.js";
import { BLOCKING_LANDINGS } from "$lib/resolve-landing.js";

// Launch-fact collection + the 5s cache live in $lib/server/landing.ts; the
// reset hook is re-exported here so tests keep one import site.
export { _resetLaunchCache } from "$lib/server/landing.js";

const logger = createLogger("admin");

let startupApplyDone = false;
// K3 (review 2026-07-10): once setup is observed complete, it stays complete
// for the life of the process — a live install never regresses to
// incomplete. Memoizing false→true means isSetupComplete's dotenv-parse +
// existsSync work runs at most once per process instead of on every request
// (including every /api/*, /proxy/*, and the host UI's 10s poll).
let setupCompleteMemo = false;

/** Test-only: clear the setup-complete memo so each test resolves fresh. */
export function _resetSetupCompleteMemo(): void {
  setupCompleteMemo = false;
}

// Load the process-level config the UI needs to serve, READ-ONLY w.r.t. OP_HOME.
// install/update own every OP_HOME write (via applyHome), so merely serving
// the UI never mutates the home directory — no startup "auto-apply".
function loadProcessEnv(): void {
  if (startupApplyDone) return;
  startupApplyDone = true;

  // Warn early if any bind address is non-loopback. #563 — preset-aware: a
  // matched network access preset collapses to one informational line;
  // unexplained exposure stays loud (D9).
  for (const line of collectNetworkExposureWarnings(process.env as Record<string, string>)) {
    logger.warn(line);
  }

  try {
    const state = getState();
    // Fallback for the UI login password: production `openpalm ui serve`
    // (packages/cli/src/lib/ui-server.ts) injects OP_UI_LOGIN_PASSWORD before
    // spawning the UI by reading the `op_ui_login_password` file secret. The
    // raw `vite dev` server has no such launcher, so when the env var is unset
    // read it from the same file secret here. No-op in production.
    if (!process.env.OP_UI_LOGIN_PASSWORD) {
      const pw = readSecret(state.homeDir, "op_ui_login_password");
      if (pw) process.env.OP_UI_LOGIN_PASSWORD = pw.trimEnd();
    }
    // Promote stack.env values into process.env so lazy reads (OpenCode URL,
    // assistant port) in server modules pick up the correct values.
    const stackVars = readStackRuntimeEnv(state.homeDir);
    for (const [k, v] of Object.entries(stackVars)) {
      if (v && !process.env[k]) process.env[k] = v;
    }
    // #488 — host-side LAN mDNS advertisement; no-op socket-free when every
    // bind is loopback (the default) or OP_MDNS=off. This is the single
    // start locus: every supervisor spawns this process, so the CLI needs no
    // separate wiring.
    reconcileMdnsResponder(state.homeDir);
  } catch (err) {
    logger.error("process env load failed", { error: String(err) });
  }
}

// Run immediately on module load (server startup)
loadProcessEnv();

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

export const handle: Handle = async ({ event, resolve }) => {
  const runtimeContext = computeServerRuntimeContext(event);
  // PR #564 second retest: thread requestId so the global Host/Origin rejections
  // carry it too, matching the documented "every error body has requestId" contract.
  const requestId = getRequestId(event);
  const hostError = checkHostHeader(event.request, requestId);
  if (hostError) return hostError;
  const originError = checkOriginHeader(event.request, runtimeContext.security.csrfMode, requestId);
  if (originError) return originError;

  const path = event.url.pathname;
  const isAuthPath = path === "/login" || path.startsWith("/login/");
  const wantsHtml =
    event.request.method === "GET" &&
    (event.request.headers.get("accept") ?? "").includes("text/html");

  // Capability gate: the /host control plane only renders where the server
  // advertises the host:* capability set (plan Phase 4 step 4 — the old
  // admin feature-flag gate, re-expressed as a capability check; the SECURITY
  // boundary stays server-side in every /api/host/* route via
  // requireCapability). Redirect to /chat so the user lands somewhere useful.
  // /admin/* is deliberately NOT gated or aliased: the tree is deleted, so
  // requests fall through to the router's 404 (plan §6.4 "No /admin alias").
  if (
    (path === '/host' || path.startsWith('/host/')) &&
    !runtimeContext.serverCapabilities.includes('host:stack:read')
  ) {
    redirect(302, '/chat');
  }
  const isSetupPath = SETUP_PATHS.some(p => path === p || path.startsWith(`${p}/`));

  // SEC-4: While setup is not yet complete the /setup routes are unauthenticated
  // by design (first-run). Restrict them to the local machine so a remote actor
  // can't race the owner to configure the stack. After setup completes the
  // re-run path at /setup?rerun=1 requires admin auth and this guard is skipped.
  const homeDir = resolveOpenPalmHome();
  const setupComplete = setupCompleteMemo || isSetupComplete(homeDir);
  if (setupComplete) setupCompleteMemo = true;
  const localInstallState = getCachedLocalInstallState(stackDirFor(homeDir), homeDir);

  if (
    wantsHtml &&
    !setupComplete &&
    localInstallState !== 'not_installed' &&
    !isSetupPath &&
    !isAuthPath &&
    !path.startsWith('/admin')
  ) {
    redirect(302, '/setup');
  }

  if (isSetupPath && !setupComplete && !isRemoteSetupAllowed()) {
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

  // ── Launch routing: document navigations land where resolveLanding() says
  // (plan ui-runtime-modes-plan.md §6.5, Phase 3). Fires BEFORE the auth guard
  // so `/` and stale `/splash` bookmarks never bounce through /login first.
  // The /splash ROUTE is gone (Phase 3 split it into /attention + the §6.5
  // landings); the /splash PATH keeps redirecting here for this release.
  if (!isSetupPath) {
    const landing = await resolveRequestLanding(event);
    const [landingPath] = landing.split('?');
    const usageRoute = path.startsWith('/chat') || path.startsWith('/advanced')
      || path.startsWith('/connections');
    // J3 (review 2026-07-10): usage routes are exempt from the landing
    // redirect EXCEPT when the resolved landing is BLOCKING (a migration in
    // progress). Nothing produces that status today ($lib/server/landing.ts's
    // migration.status is always 'none'), so this branch is inert until the
    // first real blocking migration exists — but it must be wired ahead of
    // that migration, not as a hotfix once one ships and finds
    // chat/advanced/connections silently bypassing the blocking screen.
    //
    // K4 (review 2026-07-11): membership in BLOCKING_LANDINGS, not a literal
    // '/attention' string comparison — a future second blocking landing only
    // needs registering in that set (resolve-landing.ts) to also gate these
    // routes, with no changes required here.
    const usageExempt = usageRoute && !BLOCKING_LANDINGS.has(landingPath);
    // '/host' is the admin surface itself; '/admin' stays exempt so requests
    // into the dead namespace fall through to the router 404 instead of
    // bouncing to the landing (no alias, no gate — plan Phase 4 step 1).
    const exempt = path.startsWith('/api/') || path.startsWith('/proxy/') || path.startsWith('/login')
      || path.startsWith('/health') || path.startsWith('/guardian/health') || path.startsWith('/host')
      || path.startsWith('/admin') || usageExempt;
    if (path === '/' || (path !== landingPath && !exempt)) {
      redirect(302, landing);
    }
  }

  // ── Admin auth: resolve the session role once per request, then gate page
  // navigations. This is the single auth boundary for the UI — pages carry no
  // auth code and never flash a login screen, because the server decides before
  // any HTML is sent.
  //
  // Only *document* navigations (GET + `Accept: text/html`) are redirected to
  // /login. API/data requests are left alone: every /api/host/* and
  // /api/assistant/* endpoint enforces auth itself via requireAdmin() and must
  // return JSON 401, not an HTML 302 (browser fetch() sends `Accept: */*`, so
  // it never matches here).
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
    path === '/api/host/akm/health-report' ? 'SAMEORIGIN' : 'DENY',
  );
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
};
