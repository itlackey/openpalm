/**
 * Server-side landing resolution.
 *
 * Collects the launch facts (local install state and container health) and runs them
 * through the pure `resolveLanding()`. Used by hooks.server.ts for document
 * navigations to `/` and `/splash`, and by routes/+page.server.ts for
 * client-side navigations to `/`.
 *
 * The server cannot detect the client display mode (client-only by design),
 * so capabilities are resolved with the 'browser' baseline —
 * which yields the correct host:setup gating for every process: an
 * adminCapable process keeps its host:* capabilities in a browser, and a
 * non-admin process never had them.
 */
import type { RequestEvent } from '@sveltejs/kit';
import {
  buildComposeOptions,
  classifyLocalInstall,
  composePs,
  deriveLaunchStatus,
  deriveLocalStackState,
  type ComposeServiceStatus,
} from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { CONNECTIONS_HINT_COOKIE } from '$lib/connections/landing-hint.js';
import { computeServerRuntimeContext } from '$lib/server/features.js';
import { resolveCapabilities } from '$lib/runtime-context.svelte.js';
import { resolveLanding, type LaunchState } from '$lib/resolve-landing.js';
import type { ClientContext, RuntimeContext } from '$lib/types.js';

type LaunchRouting = {
  installState: ReturnType<typeof classifyLocalInstall>;
  launch: ReturnType<typeof deriveLaunchStatus>;
};

let launchRoutingCache: { expiresAt: number; value: LaunchRouting } | null = null;

// Review 2026-07-10 K3: classifyLocalInstall does several existsSync +
// dotenv-parse calls. hooks.server.ts's early setup guard needs the same
// install-state classification resolveLaunchRouting() below computes, but
// runs BEFORE the landing resolution (and for every request, including
// /api/* and /proxy/* traffic and the host UI's poll) — so it shares this
// cache rather than calling classifyLocalInstall a second, uncached time.
let installStateCache: { expiresAt: number; value: ReturnType<typeof classifyLocalInstall> } | null = null;

/** Clear cached launch facts after setup or another local-state transition. */
export function clearLaunchRoutingCache(): void {
  launchRoutingCache = null;
  installStateCache = null;
}

/** Test-only alias retained as the shared reset seam for launch-routing tests. */
export function _resetLaunchCache(): void {
  clearLaunchRoutingCache();
}

/**
 * classifyLocalInstall, cached for 5s (K3). Shared by hooks.server.ts's
 * setup guard and resolveLaunchRouting() below, so a request that touches
 * both call sites only classifies the install once.
 */
export function getCachedLocalInstallState(
  stackDir: string,
  homeDir: string,
): ReturnType<typeof classifyLocalInstall> {
  if (installStateCache && installStateCache.expiresAt > Date.now()) {
    return installStateCache.value;
  }
  const value = classifyLocalInstall(stackDir, homeDir);
  installStateCache = { value, expiresAt: Date.now() + 5_000 };
  return value;
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
      // Skip malformed compose ps lines — health derives from the valid ones.
    }
  }
  return services;
}

async function resolveLaunchRouting(): Promise<LaunchRouting> {
  if (launchRoutingCache && launchRoutingCache.expiresAt > Date.now()) {
    return launchRoutingCache.value;
  }
  const state = getState();
  const installState = getCachedLocalInstallState(state.stackDir, state.homeDir);
  if (installState === 'not_installed') {
    const value = {
      installState,
      launch: deriveLaunchStatus({
        local: { state: 'not_installed', detail: { installState } },
        remotes: [],
      }),
    };
    launchRoutingCache = { value, expiresAt: Date.now() + 5_000 };
    return value;
  }
  const composeResult = await composePs(buildComposeOptions(state));
  const services = composeResult.ok ? parseComposePsServices(composeResult.stdout) : [];
  const localState = deriveLocalStackState(installState, services);
  const launch = deriveLaunchStatus({
    local: {
      state: localState,
      detail: { installState },
    },
    remotes: [],
  });
  const value = { installState, launch };
  launchRoutingCache = { value, expiresAt: Date.now() + 5_000 };
  return value;
}

/**
 * Read the browser's connections hint, tolerating an event without a cookie
 * jar. This resolver decides where EVERY document navigation goes, so it must
 * degrade to "no hint" rather than throw and take routing down with it.
 */
export function readConnectionsHint(event: RequestEvent): boolean {
  const get = event.cookies?.get;
  if (typeof get !== 'function') return false;
  try {
    return event.cookies.get(CONNECTIONS_HINT_COOKIE) === '1';
  } catch {
    return false;
  }
}

/**
 * Resolve the landing path for a request via resolveLanding().
 * May return a path with a query string (e.g. '/host?tab=diagnostics').
 */
export async function resolveRequestLanding(event: RequestEvent): Promise<string> {
  const serverCtx = computeServerRuntimeContext(event);
  const clientContext: ClientContext = { displayMode: 'browser' };
  const ctx: RuntimeContext = {
    ...serverCtx,
    clientContext,
    effectiveCapabilities: resolveCapabilities(serverCtx.serverCapabilities, clientContext),
  };

  const { installState, launch } = await resolveLaunchRouting();
  // Preserve the pre-Phase-3 nuance: an interrupted install whose containers
  // happen to be running still needs the wizard finished — land it on /setup
  // (the old router special-cased this combination to the splash's "resume
  // setup" card), not on chat against a half-configured stack.
  const localState =
    installState === 'setup_incomplete' && launch.local.state === 'running'
      ? 'setup_incomplete'
      : launch.local.state;
  // Connections are browser-owned (IndexedDB), so the only way this request can
  // know the browser has any is the client hint cookie it carries. Without it
  // the server cannot tell a fresh machine from one with remote assistants
  // already configured, and answers /start for both — which is why a returning
  // user was routed through the welcome screen on every launch.
  //
  // A HINT, not an authorization: it is client-controlled, and the most a
  // forged value can do is land a browser on /chat instead of /start. Both are
  // public usage routes in this lane and nothing else reads it. See
  // $lib/connections/landing-hint.ts.
  //
  // Read from `event`, deliberately OUTSIDE resolveLaunchRouting() — that
  // function's launch facts are cached process-wide for 5s, and a per-request
  // client hint must never be baked into a shared cache entry.
  const browserConnections = readConnectionsHint(event);
  const connections: LaunchState['connections'] = launch.hasHealthyLocal ? [{ id: 'default' }] : [];
  const launchState: LaunchState = {
    // No blocking migration exists yet — the gate (and /attention) is wired
    // ahead of the first one.
    migration: { status: 'none' },
    local: { state: localState },
    connections,
    browserConnections,
  };
  return resolveLanding(ctx, launchState);
}
