/**
 * SvelteKit server hooks — runs once on admin startup.
 *
 * Performs an idempotent auto-apply: ensures home dirs exist, seeds
 * secrets and OpenCode config, and resolves runtime files. Outcomes are
 * surfaced via the application logger; OpenCode session logs + the
 * guardian's own guardian-audit.log are the audit trail (D6a of the
 * auth/proxy refactor).
 *
 * Also enforces SEC-1: Host header allowlist to prevent DNS rebinding attacks.
 */
import type { Handle } from "@sveltejs/kit";
import { redirect } from "@sveltejs/kit";
import { getState } from "$lib/server/state.js";
import { checkHostHeader, checkOriginHeader, getRequestId, identifyCallerByToken, requireAdmin, requireCapability } from "$lib/server/helpers.js";
import { touchSession } from "$lib/server/session-store.js";
import { sessionCookieHeader, SESSION_COOKIE_NAME } from "$lib/server/session-cookie.js";
import { computeServerRuntimeContext } from '$lib/server/features.js';
import {
  createLogger,
  isSetupComplete,
  resolveOpenPalmHome,
  readStackRuntimeEnv,
  readSecret,
  describeAccessExposure,
  readAccessToggles,
  runHomeMigrations,
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
let migrationsDone = false;

// Bring the home up to the current schema BEFORE anything reads it.
//
// This lives HERE, and nowhere else. Every serve path spawns THIS process, so
// one owner here covers the Electron harness, the CLI supervisor, and `vite
// dev` alike, and the migration ships with the schema it implements.
//
// Schema-gated and idempotent: an up-to-date home reads one small version file
// and returns. Non-fatal — a home that cannot be migrated must still serve,
// degraded, rather than refuse to boot.
function migrateHome(): void {
  if (migrationsDone) return;
  migrationsDone = true;
  try {
    runHomeMigrations(resolveOpenPalmHome());
  } catch (err) {
    logger.error("home migration failed", { error: String(err) });
  }
}

// Load the process-level config the UI needs to serve, READ-ONLY w.r.t. OP_HOME.
// install/update own every OP_HOME write (via applyHome), so merely serving
// the UI never mutates the home directory — no startup "auto-apply".
function loadProcessEnv(): void {
  if (startupApplyDone) return;
  startupApplyDone = true;

  // Report what the operator deliberately opened. Exposure is now read from
  // the access toggles rather than diagnosed from bind addresses:
  // unexplained exposure stays loud (D9).
  for (const line of describeAccessExposure(readAccessToggles(process.env as Record<string, string>))) {
    logger.warn(line);
  }

  try {
    const state = getState();
    // Fallback for the UI login password: the production CLI UI supervisor
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
    // bind is loopback (the default) or OP_MDNS=off, and a no-op entirely
    // inside the container UI co-process (OP_UI_SERVED_IN_CONTAINER=1 — this
    // hooks.server.ts also runs there, non-admin). This is the single start
    // locus: every supervisor spawns this process, so the CLI needs no
    // separate wiring. It is also the ONLY call needed for this process's
    // whole lifetime — reconcileMdnsResponder arms its own 60s re-read of
    // stack.env internally (0.14.0 LAN-access review, Phase 2), so a
    // long-lived sibling process that never serves a stack-settings write
    // still converges within a minute instead of advertising stale state
    // forever.
    reconcileMdnsResponder(state.homeDir);
  } catch (err) {
    logger.error("process env load failed", { error: String(err) });
  }
}

// Run immediately on module load (server startup), migrations first so the env
// load below reads a current stack.env.
//
// There is no longer a process-local "port contract reconciliation" here. It
// re-implemented an on-disk migration inside the request path, keyed on magic
// literals ('3800' in the live env meant "an inherited retired default"), so an
// operator who deliberately ran the assistant on 3800 got a UI whose proxy
// targeted 3810 while compose still published 3800 — assistant_unreachable with
// nothing in stack.env to explain it. Its two triggers also disagreed with the
// disk migration's at the edges. The real migration now runs here, once, before
// anything reads the home, so the request path can simply trust the disk.
migrateHome();
loadProcessEnv();

// Scheduler is now a dedicated sidecar — admin has zero background processes.

// Paths exempt from the setup guard (setup UI itself + health probes)
const SETUP_PATHS = ["/setup", "/api/setup", "/health", "/guardian/health"];

// Static PWA assets (#511) — must be servable pre-auth and regardless of
// setup state so a browser can discover installability (fetch the
// manifest + icons), and so the service worker can register, before the
// user has ever logged in or finished setup. Same treatment as /health:
// never redirected to /setup, the resolved landing, or /login.
const PWA_ASSET_PATHS = [
  "/manifest.webmanifest",
  "/service-worker.js",
  "/pwa-192x192.png",
  "/pwa-512x512.png",
  "/maskable-512x512.png",
];

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

function isLocalhostName(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
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
  const isPwaAssetPath = PWA_ASSET_PATHS.includes(path);
  const isSetupPage = path === '/setup' || path.startsWith('/setup/');
  const isSetupApi = path === '/api/setup' || path.startsWith('/api/setup/');
  const isPublicSetupApi = path === '/api/setup/status';
  const wantsHtml =
    event.request.method === "GET" &&
    (event.request.headers.get("accept") ?? "").includes("text/html");

  if (isSetupPage || (isSetupApi && !isPublicSetupApi)) {
    const capabilityError = requireCapability(event, 'host:setup', requestId);
    if (capabilityError) return capabilityError;
  }

  // Capability gate: the /host control plane only renders where the server
  // advertises the host:* capability set (the old
  // admin feature-flag gate, re-expressed as a capability check; the SECURITY
  // boundary stays server-side in every /api/host/* route via
  // requireCapability). Redirect to /chat so the user lands somewhere useful.
  // /admin/* is deliberately NOT gated or aliased: the tree is deleted, so
  // requests fall through to the router's 404 ("No /admin alias").
  if (
    (path === '/host' || path.startsWith('/host/')) &&
    !runtimeContext.serverCapabilities.includes('host:stack:read')
  ) {
    redirect(302, '/chat');
  }
  const isSetupPath = SETUP_PATHS.some(p => path === p || path.startsWith(`${p}/`));

  // A process that cannot SERVE /setup must never redirect anyone TO it.
  // Sending a browser to a route this same process answers with 403
  // capability_not_available is a closed loop with no way out — it is how the
  // CLI wizard shipped broken (a non-admin `openpalm install` UI redirected
  // every navigation to a /setup it then refused), and it is also how a
  // write into the assistant-writable home could lock every LAN client out of
  // the container UI by flipping its install state to 'setup_incomplete'.
  // Gating the redirect on the capability makes the deadlock unrepresentable
  // in every harness rather than relying on each launcher to pass the right
  // flag.
  const canServeSetup = runtimeContext.serverCapabilities.includes('host:setup');

  // SEC-4: While setup is not yet complete the /setup routes are unauthenticated
  // by design (first-run). Restrict them to the local machine so a remote actor
  // can't race the owner to configure the stack. After setup completes the
  // re-run path at /setup?rerun=1 requires admin auth and this guard is skipped.
  const homeDir = resolveOpenPalmHome();
  const setupComplete = isSetupComplete(homeDir);
  const localInstallState = getCachedLocalInstallState(stackDirFor(homeDir), homeDir);
  const publicFirstRunSetup = isSetupPath && !setupComplete;

  if (
    wantsHtml &&
    canServeSetup &&
    !setupComplete &&
    localInstallState !== 'not_installed' &&
    !isSetupPath &&
    !isAuthPath &&
    !isPwaAssetPath &&
    !path.startsWith('/admin')
  ) {
    redirect(302, '/setup');
  }

  if ((isSetupPage || isSetupApi) && !setupComplete) {
    const clientIp = event.getClientAddress();
    if (!isLocalhostAddress(clientIp) || !isLocalhostName(event.url.hostname)) {
      return new Response(
        JSON.stringify({
          error: "setup_localhost_only",
          message: "Setup is only accessible from the host machine until installation is complete.",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }
  }

  if (
    wantsHtml
    && canServeSetup
    && localInstallState === 'not_installed'
    && (path === '/host' || path.startsWith('/host/'))
  ) {
    redirect(302, '/setup');
  }

  // ── Launch routing: document navigations land where resolveLanding() says.
  // Fires BEFORE the auth guard
  // so `/` and stale `/splash` bookmarks never bounce through /login first.
  // The /splash ROUTE is gone (Phase 3 split it into /attention + the §6.5
  // landings); the /splash PATH keeps redirecting here for this release.
  // Only DOCUMENT navigations land where resolveLanding() says. A fetch()
  // surface (/api, /health, /voice, an SSE endpoint, any future proxy) sends
  // `Accept: */*`, never text/html — redirecting it 302s the caller into an
  // HTML page it then misparses (this is exactly what broke /voice speech
  // calls). Gating on `wantsHtml` exempts every fetch route by construction
  // instead of maintaining a hardcoded prefix list, and skips the
  // resolveRequestLanding() cost (a docker `compose ps` + target probe on
  // launch-cache miss) for the non-navigation traffic that can't be redirected
  // anyway.
  if (!isSetupPath && !isPwaAssetPath && wantsHtml) {
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
    // chat/advanced/settings silently bypassing the blocking screen.
    //
    // K4 (review 2026-07-11): membership in BLOCKING_LANDINGS, not a literal
    // '/attention' string comparison — a future second blocking landing only
    // needs registering in that set (resolve-landing.ts) to also gate these
    // routes, with no changes required here.
    const usageExempt = usageRoute && !BLOCKING_LANDINGS.has(landingPath);
    // '/host' is the admin surface itself; '/admin' stays exempt so requests
    // into the dead namespace fall through to the router 404 instead of
    // bouncing to the landing (no alias, no gate — plan Phase 4 step 1). The
    // fetch-only prefixes (/api, /health, /guardian/health) are already
    // excluded by the wantsHtml gate above, but stay listed defensively in
    // case a client sends Accept: text/html to one.
    const exempt = path.startsWith('/api/') || path.startsWith('/login')
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

  if (
    setupComplete
    && isSetupApi
    && !isPublicSetupApi
  ) {
    const authError = requireAdmin(event, requestId);
    if (authError) return authError;
  }

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

  // ── Client-only public lane (PR #571 review P1, #511): a process
  // with no local install and no login password configured — e.g. a hosted
  // PWA origin serving the browser-owned client — has nothing behind the
  // login wall: connections and their credentials live in the browser,
  // host:* capabilities don't exist in this process, and every /api/host/*
  // and /api/assistant/* route enforces its own auth. Redirecting would
  // dead-end the installed app, because /login POSTs 503 when no password
  // exists. The usage routes stay public in exactly this lane; every other
  // lane (any local install present, or a password
  // configured) keeps the wall unchanged.
  const clientOnlyPublicUsage =
    localInstallState === 'not_installed' &&
    !process.env.OP_UI_LOGIN_PASSWORD &&
    (path === '/start' || path.startsWith('/chat') || path.startsWith('/advanced') || path.startsWith('/connections'));

  if (wantsHtml && !event.locals.role && !publicFirstRunSetup && !isAuthPath && !isPwaAssetPath && !clientOnlyPublicUsage) {
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
