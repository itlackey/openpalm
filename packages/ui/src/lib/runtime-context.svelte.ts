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

/**
 * Populate ONLY the server half of the store (everything ServerRuntimeContext
 * carries — capabilities, routes, hostMode, security, versions) and re-derive
 * `effectiveCapabilities` against whatever clientContext is already in the
 * store (the 'browser' baseline until the client half runs).
 *
 * Review 2026-07-10 K2: pre-migration, the equivalent `featuresService.init()`
 * ran directly in +layout.svelte's script body (an `untrack()`-wrapped call,
 * not inside `onMount`) — so it executed during SSR too, and the FIRST
 * server-rendered HTML already reflected the real capabilities (e.g. the
 * admin button was present in SSR output). At HEAD, `initializeRuntimeContext`
 * only ran in `onMount`, which never fires during SSR — every full/hard load
 * server-rendered with the store still at its all-capabilities-empty default,
 * producing a flash of missing chrome until client-side hydration ran.
 *
 * `detectClientDisplayMode()` (the other half) still genuinely needs the
 * browser (matchMedia / navigator), so it stays client-only in `onMount` —
 * only the server half moves earlier. The 'browser' clientContext default is
 * correct for the common case (regular browser tab), so capabilities
 * resolved here already match what `onMount` would (re)compute for that case;
 * `onMount` only changes the outcome for electron / standalone-pwa displays.
 */
export function initializeServerRuntimeContext(serverCtx: ServerRuntimeContext): void {
  Object.assign(runtimeContext, serverCtx);
  runtimeContext.effectiveCapabilities = resolveCapabilities(
    serverCtx.serverCapabilities,
    runtimeContext.clientContext,
  );
}
