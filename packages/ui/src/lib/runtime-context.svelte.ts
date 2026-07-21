/**
 * Runtime context — RuntimeContext v2 (issue #509).
 *
 * This module is the ONLY place capability logic lives. Components call
 * `hasCapability(cap)` and nothing else — no scattered `if (features.admin)`
 * checks. `hasCapability()` is UX only; APIs enforce capabilities
 * server-side.
 *
 * Each root layout owns one context instance. This keeps SSR state scoped to
 * the request/component tree instead of leaking through a module singleton.
 */
import { getContext, setContext } from 'svelte';
import type {
  Capability,
  ClientContext,
  RuntimeContext,
  ServerRuntimeContext,
} from '$lib/types.js';

const RUNTIME_CONTEXT_KEY = Symbol('openpalm.runtime-context');

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

export function createRuntimeContext(serverCtx: ServerRuntimeContext): RuntimeContext {
  const clientContext: ClientContext = { displayMode: 'browser' };
  const context = $state<RuntimeContext>({
    ...serverCtx,
    clientContext,
    effectiveCapabilities: resolveCapabilities(serverCtx.serverCapabilities, clientContext),
  });
  return context;
}

export function provideRuntimeContext(context: RuntimeContext): void {
  setContext(RUNTIME_CONTEXT_KEY, context);
}

export function getRuntimeContext(): RuntimeContext {
  const context = getContext<RuntimeContext | undefined>(RUNTIME_CONTEXT_KEY);
  if (!context) throw new Error('Runtime context is unavailable outside the root layout');
  return context;
}

export function hasCapability(context: RuntimeContext, cap: Capability): boolean {
  return context.effectiveCapabilities.includes(cap);
}

export function initializeRuntimeContext(
  context: RuntimeContext,
  serverCtx: ServerRuntimeContext,
  clientCtx: ClientContext,
): void {
  Object.assign(context, serverCtx, {
    clientContext: clientCtx,
    effectiveCapabilities: resolveCapabilities(serverCtx.serverCapabilities, clientCtx),
  });
}
