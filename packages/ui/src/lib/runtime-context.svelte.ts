/**
 * Runtime context — RuntimeContext v2 (plan ui-runtime-modes-plan.md §6.2,
 * issue #509).
 *
 * This module is the ONLY place capability logic lives. Components call
 * `hasCapability(cap)` and nothing else — no scattered `if (features.admin)`
 * checks (plan §8.6). `hasCapability()` is UX only; APIs enforce capabilities
 * server-side (plan §8.5).
 *
 * The `runtimeContext` store is populated by +layout.svelte from the layout
 * server data (ServerRuntimeContext) plus the browser-detected ClientContext,
 * and `effectiveCapabilities` is re-derived on every change.
 */
import type {
  Capability,
  ClientContext,
  RuntimeContext,
  ServerRuntimeContext,
} from '$lib/types.js';

export function resolveCapabilities(
  serverCaps: Capability[],
  clientCtx: ClientContext,
): Capability[] {
  const { displayMode, activeConnection } = clientCtx;

  if (displayMode === 'electron') return serverCaps;

  if (serverCaps.includes('host:stack:read') && displayMode === 'browser') {
    return serverCaps.filter((c) => !isElectronOnlyCap(c));
  }

  if (serverCaps.includes('connections:single')) {
    // assistant-container: chat + assistant settings
    return serverCaps.filter((c) => c === 'chat' || c.startsWith('assistant-settings'));
  }

  // pwa-static: connections + chat
  let caps = serverCaps.filter(
    (c) => c.startsWith('connections') || c === 'chat' || c === 'pwa:install',
  );

  // Extension point: active connection may grant additional capabilities
  if (activeConnection?.grantedCapabilities) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient dedupe helper inside a pure function, never held as reactive state
    caps = [...new Set([...caps, ...activeConnection.grantedCapabilities])];
  }

  return caps;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature fixed by plan §6.2; the parameter is consulted once Electron IPC-dependent capabilities exist
function isElectronOnlyCap(_c: Capability): boolean {
  return false; // reserved for future Electron IPC-dependent features
}

/**
 * Reactive runtime context. Starts at the unprivileged pwa-static baseline
 * with zero capabilities until +layout.svelte initializes it — capabilities
 * are opted INTO from server data, never defaulted on.
 */
export const runtimeContext = $state<RuntimeContext>({
  version: 2,
  hostMode: 'pwa-static',
  serverCapabilities: [],
  publicBaseUrl: '',
  uiVersion: '',
  skeletonVersion: '',
  activeConnectionMode: 'multi',
  routes: {},
  security: {
    hostAdminLoopbackOnly: true,
    requiresHttpsForRemoteConnections: true,
    csrfMode: 'loopback-origin',
  },
  clientContext: { displayMode: 'browser' },
  effectiveCapabilities: [],
});

export function hasCapability(cap: Capability): boolean {
  return runtimeContext.effectiveCapabilities.includes(cap);
}

/**
 * Populate the store from layout data + browser-detected client context and
 * re-derive `effectiveCapabilities`. Called from +layout.svelte (client-only).
 */
export function initializeRuntimeContext(
  serverCtx: ServerRuntimeContext,
  clientCtx: ClientContext,
): void {
  Object.assign(runtimeContext, serverCtx);
  runtimeContext.clientContext = clientCtx;
  runtimeContext.effectiveCapabilities = resolveCapabilities(
    serverCtx.serverCapabilities,
    clientCtx,
  );
}
