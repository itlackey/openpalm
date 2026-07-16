/**
 * Runtime context — RuntimeContext v2 (issue #509).
 *
 * This module is the ONLY place capability logic lives. Components call
 * `hasCapability(cap)` and nothing else — no scattered `if (features.admin)`
 * checks. `hasCapability()` is UX only; APIs enforce capabilities
 * server-side.
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

  // Fully-trusted surfaces get everything the server granted: Electron, and a
  // host-capable server viewed in a regular browser (`openpalm admin`). No
  // Electron-only capabilities are reserved yet, so the two are identical.
  if (
    displayMode === 'electron' ||
    (serverCaps.includes('host:stack:read') && displayMode === 'browser')
  ) {
    return serverCaps;
  }

  // Everything else — a non-admin process (served/PWA), or a host-capable
  // server on a standalone-pwa display where host:* is not usable: keep the
  // base surface (chat + connections + assistant-settings + pwa:install) and
  // drop host:* .
  let caps = serverCaps.filter((c) => !c.startsWith('host:'));

  // Extension point: active connection may grant additional capabilities
  if (activeConnection?.grantedCapabilities) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient dedupe helper inside a pure function, never held as reactive state
    caps = [...new Set([...caps, ...activeConnection.grantedCapabilities])];
  }

  return caps;
}

/**
 * Reactive runtime context. Starts at the unprivileged non-admin baseline
 * with zero capabilities until +layout.svelte initializes it — capabilities
 * are opted INTO from server data, never defaulted on.
 */
export const runtimeContext = $state<RuntimeContext>({
  version: 2,
  admin: false,
  serverCapabilities: [],
  publicBaseUrl: '',
  uiVersion: '',
  skeletonVersion: '',
  routes: {},
  security: {
    hostAdminLoopbackOnly: true,
    requiresHttpsForRemoteConnections: true,
    csrfMode: 'same-site',
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
 * carries — capabilities, routes, admin, security, versions) and re-derive
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
 *
 * `publicBaseUrl` is deliberately EXCLUDED: it is the one request-derived
 * field (`event.url.origin`), and during SSR this store is process-global
 * under adapter-node — writing it here would leak one request's Host-derived
 * origin to every later reader (PR #562 review). SSR chrome only needs
 * capabilities/admin/routes; the browser writes publicBaseUrl per-tab via
 * `initializeRuntimeContext` in `onMount`.
 */
export function initializeServerRuntimeContext(serverCtx: ServerRuntimeContext): void {
  // `voice` is request-derived too (its hostname comes from the request Host,
  // like publicBaseUrl) — same SSR process-global leak rule applies.
  const { publicBaseUrl: _requestDerived, voice: _requestDerivedVoice, ...envDerived } = serverCtx;
  Object.assign(runtimeContext, envDerived);
  runtimeContext.effectiveCapabilities = resolveCapabilities(
    serverCtx.serverCapabilities,
    runtimeContext.clientContext,
  );
}
