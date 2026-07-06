import type { RequestEvent } from '@sveltejs/kit';
import { PLATFORM_VERSION } from '@openpalm/lib';
import uiPkg from '../../../package.json';
import type { Capability, FeatureFlags, ServerRuntimeContext, UiHostMode } from '$lib/types.js';

/**
 * Server runtime context — RuntimeContext v2 (plan ui-runtime-modes-plan.md
 * §6.1, issue #509). Computed server-side on every request via
 * +layout.server.ts and served publicly at GET /api/runtime (the
 * contract-version handshake for remote/hosted clients).
 *
 * hostMode resolution (Phase 1):
 *   OP_UI_HOST_MODE (explicit) → that mode
 *   else OP_INSIDE_ELECTRON=1  → 'electron-host' (legacy, injected by
 *                                 packages/electron/src/main.ts)
 *   else OP_ENABLE_ADMIN=1     → 'host-ui' (legacy, local dev / openpalm admin)
 *   else                       → 'pwa-static' baseline
 */

const HOST_MODES: readonly UiHostMode[] = [
  'electron-host',
  'host-ui',
  'assistant-container',
  'pwa-static',
];

function isUiHostMode(value: string): value is UiHostMode {
  return (HOST_MODES as readonly string[]).includes(value);
}

function resolveHostMode(): UiHostMode {
  const explicit = process.env.OP_UI_HOST_MODE?.trim() ?? '';
  if (isUiHostMode(explicit)) return explicit;
  if (process.env.OP_INSIDE_ELECTRON === '1') return 'electron-host';
  if (process.env.OP_ENABLE_ADMIN === '1') return 'host-ui';
  return 'pwa-static';
}

/** The full host:* capability set (plan §6.1) — host-capable modes only. */
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

/** Capabilities of a host-capable process (electron-host / host-ui). Note:
 *  never 'connections:single' — that marker is the assistant-container
 *  branch key in resolveCapabilities() (plan §6.2). */
const HOST_MODE_CAPABILITIES: readonly Capability[] = [
  'chat',
  'connections:read',
  'connections:manage',
  'connections:switch',
  'assistant-settings:read',
  'assistant-settings:write',
  ...HOST_CAPABILITIES,
];

const SERVER_CAPABILITIES: Record<UiHostMode, readonly Capability[]> = {
  'electron-host': HOST_MODE_CAPABILITIES,
  'host-ui': HOST_MODE_CAPABILITIES,
  // Single locked connection to the local OpenCode: chat + assistant settings,
  // no host:* and no connection management.
  'assistant-container': [
    'connections:single',
    'chat',
    'assistant-settings:read',
    'assistant-settings:write',
  ],
  // Baseline: connection management + chat (when connected) + PWA install.
  'pwa-static': [
    'chat',
    'connections:read',
    'connections:manage',
    'connections:switch',
    'pwa:install',
  ],
};

/** Route pointers per mode — current-truth URLs (pre-Phase-3 route split).
 *  Phase 2 (#486) moved connections to /connections (the /admin/endpoints
 *  alias redirects there for 0.13.0); Phase 4 moves /admin to /host. */
function routesForMode(mode: UiHostMode): ServerRuntimeContext['routes'] {
  switch (mode) {
    case 'electron-host':
    case 'host-ui':
      return {
        chat: '/chat',
        connections: '/connections',
        host: '/admin',
        setup: '/setup',
      };
    case 'assistant-container':
      return { chat: '/chat' };
    case 'pwa-static':
      // Connection management is capability-guarded, not host-admin-gated —
      // reachable in pwa-static (plan §4.3).
      return { chat: '/chat', connections: '/connections' };
  }
}

export function computeServerRuntimeContext(event: RequestEvent): ServerRuntimeContext {
  const hostMode = resolveHostMode();
  const isHostCapable = hostMode === 'electron-host' || hostMode === 'host-ui';
  return {
    version: 2,
    hostMode,
    serverCapabilities: [...SERVER_CAPABILITIES[hostMode]],
    publicBaseUrl: event.url.origin,
    uiVersion: uiPkg.version,
    // Skeleton version equals platform version in production (plan §8.2);
    // OP_SKELETON_VERSION is the explicit exact-pin override (plan §3).
    skeletonVersion: process.env.OP_SKELETON_VERSION?.trim() || PLATFORM_VERSION,
    activeConnectionMode: hostMode === 'assistant-container' ? 'single' : 'multi',
    routes: routesForMode(hostMode),
    security: {
      // Host admin is loopback-only and never weakened (plan §8.3).
      hostAdminLoopbackOnly: true,
      // Only browser-direct remote connections (the static client) need HTTPS;
      // host modes proxy server-side (plan §6.10).
      requiresHttpsForRemoteConnections: hostMode === 'pwa-static',
      csrfMode: isHostCapable
        ? 'loopback-origin'
        : hostMode === 'assistant-container'
          ? 'same-site'
          : 'bearer-token',
    },
  };
}

/**
 * Legacy feature flags — kept as a DERIVED ALIAS of the runtime context until
 * the features.admin → hasCapability() migration completes (plan Phase 1).
 *
 * admin: true exactly when the resolved hostMode is host-capable, which
 * preserves the pre-Phase-1 behavior (OP_INSIDE_ELECTRON=1 → electron-host,
 * OP_ENABLE_ADMIN=1 → host-ui, both → admin).
 */
export function computeFeatureFlags(): FeatureFlags {
  const hostMode = resolveHostMode();
  return {
    admin: hostMode === 'electron-host' || hostMode === 'host-ui',
  };
}
