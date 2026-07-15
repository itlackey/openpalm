/**
 * Server-side landing resolution (plan ui-runtime-modes-plan.md §6.5,
 * Phase 3 step 2).
 *
 * Collects the launch facts (local install state, container health, remote
 * reachability — the probes that used to feed the /splash page) and runs them
 * through the pure `resolveLanding()`. Used by hooks.server.ts for document
 * navigations to `/` and `/splash`, and by routes/+page.server.ts for
 * client-side navigations to `/`.
 *
 * The server cannot detect the client display mode (client-only by design,
 * plan §6.3), so capabilities are resolved with the 'browser' baseline —
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
  detectRuntime,
  type ComposeServiceStatus,
} from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { listRemoteStatuses } from '$lib/server/endpoints.js';
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

/** Test-only: clear the 5s launch-routing cache so each test resolves fresh. */
export function _resetLaunchCache(): void {
  launchRoutingCache = null;
  installStateCache = null;
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
  launchRoutingCache = { value, expiresAt: Date.now() + 5_000 };
  return value;
}

/**
 * Resolve the landing path for a request via resolveLanding() (plan §6.5).
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
  // Connections usable right now: accessible remotes, plus the local
  // assistant when it is healthy. Only reachable connections count — a dead
  // remote must not satisfy the "has somewhere to chat" checks (#440).
  const connections: LaunchState['connections'] = [
    ...(launch.hasHealthyLocal ? [{ id: 'default' }] : []),
    ...launch.remotes.filter((r) => r.state === 'accessible'),
  ];
  const launchState: LaunchState = {
    // No blocking migration exists yet — the gate (and /attention) is wired
    // ahead of the first one (plan §6.5).
    migration: { status: 'none' },
    local: { state: localState },
    connections,
  };
  return resolveLanding(ctx, launchState);
}
