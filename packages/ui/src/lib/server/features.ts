import type { RequestEvent } from '@sveltejs/kit';
import { listEnabledAddonIds } from '@openpalm/lib';
import uiPkg from '../../../package.json';
import type { Capability, ServerRuntimeContext } from '$lib/types.js';
import { getState } from '$lib/server/state.js';

/**
 * Server runtime context — RuntimeContext v2 (issue #509). Computed server-side on every request via
 * +layout.server.ts and served publicly at GET /api/runtime for the current
 * UI process. It is not a remote OpenPalm compatibility handshake.
 *
 * Admin capability is an Electron-or-CLI-only security boundary — there is no
 * per-mode capability matrix and no env self-grant footgun (a served/container
 * build must never be able to claim host mode). A single boolean:
 *   OP_INSIDE_ELECTRON=1 (injected by packages/electron/src/main.ts) OR
 *   OP_ENABLE_ADMIN=1    (local dev / `openpalm admin`) → adminCapable
 * Every process gets the base capability set; only an adminCapable process
 * additionally gets host:*.
 */

/**
 * True when this process is admin-capable — running inside Electron or
 * explicitly opted into admin. This is the ONLY gate for host:* capabilities;
 * a served/container/PWA build is never admin-capable.
 */
export function isAdminCapable(): boolean {
  return process.env.OP_INSIDE_ELECTRON === '1' || process.env.OP_ENABLE_ADMIN === '1';
}

/** Base capabilities for host-served UI processes. The browser owns
 * connections uniformly; the assistant-container co-process omits only the
 * canonical-host PWA install affordance below. */
const BASE_CAPABILITIES: readonly Capability[] = [
  'chat',
  'connections:read',
  'connections:manage',
  'connections:switch',
  'assistant-settings:read',
  'assistant-settings:write',
  // #511: backed for real now — every build ships static/manifest.webmanifest
  // + icons (linked from app.html) and src/service-worker.ts, so this claim
  // is no longer advertised ahead of the assets that make it true.
  'pwa:install',
];

/** The host:* capability set — added only when adminCapable. */
const HOST_CAPABILITIES: readonly Capability[] = [
  'host:setup',
  'host:stack:read',
  'host:stack:write',
  'host:containers',
  'host:addons',
  'host:updates',
  'host:logs',
  'host:secrets',
  'host:recovery',
  'host:akm-sharing',
];

/**
 * True when this process has SOME path to a voice container.
 *
 * Voice is deliberately NOT gated on admin capability — using voice is not a
 * privileged host operation, and a served non-admin `openpalm ui serve` /
 * Electron host must still offer it.
 *
 * The container co-process is the special case. By default it reaches only its
 * OWN 127.0.0.1, never the sibling voice container on another compose network,
 * so the entrypoint sets `OP_UI_NO_LOCAL_VOICE=1` and it neither advertises nor
 * proxies /voice regardless of what stack state it can read. That flag is now
 * conditional: with `OP_VOICE_LAN_ACCESS` on, voice.compose.lan.yml puts voice
 * on `assistant_net`, the entrypoint leaves the flag unset and injects
 * `OP_VOICE_URL` instead, and the co-process genuinely can reach it — see
 * {@link servedInContainerWithVoice}. Host launchers never set the flag.
 */
export function canServeLocalVoice(): boolean {
  return process.env.OP_UI_NO_LOCAL_VOICE !== '1';
}

/**
 * True when this is the assistant container's UI co-process AND the operator
 * opted into LAN voice, so the entrypoint injected an upstream URL.
 *
 * The container co-process must decide voice availability from its INJECTED
 * env, never by reading the addon list off disk. `getState().homeDir` there
 * resolves to `$HOME/.openpalm` inside the assistant's own data mount — no host
 * `OP_HOME` is injected — which holds no `stack.env`, so `listEnabledAddonIds`
 * returns `[]` and the check refuses even when voice is enabled, reachable, and
 * the network path exists. It is also agent-writable, so trusting it would let a
 * write inside the container decide what the LAN UI serves. Same
 * fail-closed-to-injected-env rule the login password follows (session-store.ts).
 *
 * `OP_VOICE_URL` is set by containers/assistant/entrypoint.sh ONLY when
 * `OP_VOICE_LAN_ACCESS` is on, so its presence IS the opt-in. When voice is off
 * or not deployed the upstream fetch simply fails and `/voice` answers 502 "not
 * responding" rather than 503 "not enabled" — an honest distinction, since this
 * process genuinely cannot tell those apart from in here.
 */
export function servedInContainerWithVoice(): boolean {
  return process.env.OP_UI_SERVED_IN_CONTAINER === '1' && !!process.env.OP_VOICE_URL?.trim();
}

/**
 * Voice advertisement for the runtime handshake: the same-origin path of the
 * /voice pass-through, present when this process can actually serve it —
 * i.e. it has a loopback path to a voice container (see canServeLocalVoice),
 * can read the stack state, and the voice addon is enabled. A process without
 * readable stack state (no OP_HOME) naturally advertises nothing. Same-origin,
 * so no host/port resolution and nothing request-derived.
 *
 * Deliberately NOT part of computeServerRuntimeContext(): that function runs
 * on requireCapability's per-request hot path, and this one reads the stack
 * env from disk. Only the two runtime-context producers (+layout.server.ts
 * and GET /api/runtime) call it.
 */
export function computeVoiceRuntime(): { url: string } | undefined {
  if (!canServeLocalVoice()) return undefined;
  if (servedInContainerWithVoice()) return { url: '/voice' };
  try {
    if (!listEnabledAddonIds(getState().homeDir).includes('voice')) return undefined;
    return { url: '/voice' };
  } catch {
    // No readable stack state → no advertisement.
    return undefined;
  }
}

export function computeServerRuntimeContext(event: RequestEvent): ServerRuntimeContext {
  const admin = isAdminCapable();
  const baseCapabilities = process.env.OP_UI_NO_LOCAL_VOICE === '1'
    ? BASE_CAPABILITIES.filter((capability) => capability !== 'pwa:install')
    : [...BASE_CAPABILITIES];
  const serverCapabilities: Capability[] = admin
    ? [...baseCapabilities, ...HOST_CAPABILITIES]
    : baseCapabilities;
  return {
    version: 2,
    admin,
    serverCapabilities,
    // Only publicBaseUrl depends on the event; requireCapability() calls this
    // from route handlers whose test event stubs may omit `url`.
    publicBaseUrl: event.url?.origin ?? '',
    uiVersion: uiPkg.version,
    // chat + connections are reachable everywhere; the host dashboard and
    // setup wizard only exist in an adminCapable process (Phase 2 (#486)
    // moved connections to /connections; Phase 4 moved the host dashboard to
    // /host — /admin/* is a dead namespace, router 404, no alias).
    routes: admin
      ? { chat: '/chat', connections: '/connections', host: '/host', setup: '/setup' }
      : { chat: '/chat', connections: '/connections' },
    security: {
      // Host admin is loopback-only and never weakened.
      hostAdminLoopbackOnly: true,
      // Browser-direct remote connections need HTTPS; the loopback admin
      // process proxies server-side and does not.
      requiresHttpsForRemoteConnections: !admin,
      csrfMode: admin ? 'loopback-origin' : 'same-site',
    },
  };
}
