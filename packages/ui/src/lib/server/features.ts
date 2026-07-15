import type { RequestEvent } from '@sveltejs/kit';
import { PLATFORM_VERSION } from '@openpalm/lib';
import uiPkg from '../../../package.json';
import type { Capability, ServerRuntimeContext } from '$lib/types.js';

/**
 * Server runtime context — RuntimeContext v2 (plan ui-runtime-modes-plan.md
 * §6.1, issue #509). Computed server-side on every request via
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

/** Base capabilities granted to EVERY process (plan §6.1). The browser owns
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

/** The host:* capability set (plan §6.1) — added only when adminCapable. */
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
    // Skeleton version equals platform version in production (plan §8.2);
    // OP_SKELETON_VERSION is the explicit exact-pin override (plan §3).
    skeletonVersion: process.env.OP_SKELETON_VERSION?.trim() || PLATFORM_VERSION,
    // chat + connections are reachable everywhere; the host dashboard and
    // setup wizard only exist in an adminCapable process (Phase 2 (#486)
    // moved connections to /connections; Phase 4 moved the host dashboard to
    // /host — /admin/* is a dead namespace, router 404, no alias).
    routes: admin
      ? { chat: '/chat', connections: '/connections', host: '/host', setup: '/setup' }
      : { chat: '/chat', connections: '/connections' },
    security: {
      // Host admin is loopback-only and never weakened (plan §8.3).
      hostAdminLoopbackOnly: true,
      // Browser-direct remote connections need HTTPS; the loopback admin
      // process proxies server-side and does not (plan §6.10).
      requiresHttpsForRemoteConnections: !admin,
      csrfMode: admin ? 'loopback-origin' : 'same-site',
    },
  };
}

// The legacy computeFeatureFlags() derived alias was deleted in Phase 4: its
// last readers (the hooks.server.ts route gate and the +layout.server.ts
// payload) migrated to capability checks, and grep found no other consumer.
