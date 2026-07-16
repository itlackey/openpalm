import type { RequestEvent } from '@sveltejs/kit';
import { PLATFORM_VERSION, listEnabledAddonIds, readStackEnv } from '@openpalm/lib';
import uiPkg from '../../../package.json';
import type { Capability, ServerRuntimeContext } from '$lib/types.js';
import { getState } from '$lib/server/state.js';

/**
 * Server runtime context — RuntimeContext v2 (issue #509). Computed server-side on every request via
 * +layout.server.ts and served publicly at GET /api/runtime (the
 * contract-version handshake for remote/hosted clients).
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

/** Base capabilities granted to EVERY process. The browser owns
 *  connections uniformly — multiple assistants + switching work everywhere. */
const BASE_CAPABILITIES: readonly Capability[] = [
  'chat',
  'connections:read',
  'connections:manage',
  'connections:switch',
  'assistant-settings:read',
  'assistant-settings:write',
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
 * Voice-endpoint advertisement for the runtime handshake. Present only when
 * the local stack has the voice addon enabled. The URL's hostname comes from
 * the REQUEST (the host the browser used to reach this UI server), so the
 * endpoint is reachable by that same browser — `127.0.0.1` in stack.env would
 * be wrong for a LAN-served UI. Plain http is correct: the container serves
 * http, and loopback/LAN targets are what it binds to.
 *
 * Deliberately NOT part of computeServerRuntimeContext(): that function runs
 * on requireCapability's per-request hot path with stub events, and this one
 * reads the stack env from disk. Only the two runtime-context producers
 * (+layout.server.ts and GET /api/runtime) call it.
 */
export function computeVoiceRuntime(event: RequestEvent): { url: string } | undefined {
  try {
    let hostname = event.url?.hostname;
    if (!hostname) return undefined;
    // URL.hostname strips the brackets from an IPv6 literal; re-add them so
    // the assembled URL parses.
    if (hostname.includes(':') && !hostname.startsWith('[')) hostname = `[${hostname}]`;
    const state = getState();
    if (!listEnabledAddonIds(state.homeDir).includes('voice')) return undefined;
    const rawPort = (
      readStackEnv(state.homeDir).OP_VOICE_PORT_HOST ||
      process.env.OP_VOICE_PORT_HOST ||
      ''
    ).trim();
    const parsed = rawPort ? Number(rawPort) : NaN;
    const port = Number.isFinite(parsed) && parsed > 0 ? parsed : 8880;
    return { url: `http://${hostname}:${port}` };
  } catch {
    // No readable stack state (served build without a host stack) → no ad.
    return undefined;
  }
}

export function computeServerRuntimeContext(event: RequestEvent): ServerRuntimeContext {
  const admin = isAdminCapable();
  const serverCapabilities: Capability[] = admin
    ? [...BASE_CAPABILITIES, ...HOST_CAPABILITIES]
    : [...BASE_CAPABILITIES];
  return {
    version: 2,
    admin,
    serverCapabilities,
    // Only publicBaseUrl depends on the event; requireCapability() calls this
    // from route handlers whose test event stubs may omit `url`.
    publicBaseUrl: event.url?.origin ?? '',
    uiVersion: uiPkg.version,
    // Skeleton version equals platform version in production;
    // OP_SKELETON_VERSION is the explicit exact-pin override.
    skeletonVersion: process.env.OP_SKELETON_VERSION?.trim() || PLATFORM_VERSION,
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

// The legacy computeFeatureFlags() derived alias was deleted in Phase 4: its
// last readers (the hooks.server.ts route gate and the +layout.server.ts
// payload) migrated to capability checks, and grep found no other consumer.
