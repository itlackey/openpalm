/**
 * Tests for lib/runtime-context.svelte.ts — RuntimeContext v2 (issue #509),
 * after the "One UI, delete the split" refactor. This module is
 * the ONLY place capability logic lives, exporting
 * `resolveCapabilities(serverCaps, clientCtx)` and request-local reactive
 * runtime contexts.
 *
 * Effective-capability rows (display-mode driven, no per-mode matrix):
 *   admin server + electron            → ALL server capabilities
 *   admin server + browser             → ALL minus Electron-only (none reserved yet)
 *   admin server + standalone-pwa      → base surface (host:* stripped)
 *   non-admin (base) + any display     → base surface
 *   activeConnection.grantedCapabilities → unioned in (deduped)
 *
 * Runs in the node ("server") vitest project; the `.svelte.ts` module is
 * compiled by the Svelte plugin, so its runes work here (same pattern as
 * lib/setup/setup-state.vitest.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Capability, ClientContext, ServerRuntimeContext } from '$lib/types.js';
import {
  createRuntimeContext,
  hasCapability,
  initializeRuntimeContext,
  resolveCapabilities,
} from './runtime-context.svelte.js';
import { computeServerRuntimeContext } from '$lib/server/features.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Order-insensitive comparison helper — the plan fixes membership, not order. */
function sorted(caps: Capability[]): Capability[] {
  return [...caps].sort();
}

const electron: ClientContext = { displayMode: 'electron' };
const browser: ClientContext = { displayMode: 'browser' };
const standalonePwa: ClientContext = { displayMode: 'standalone-pwa' };

const HOST_CAPS: Capability[] = [
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

/** The base capability set granted to EVERY process. */
const BASE_CAPS: Capability[] = [
  'chat',
  'connections:read',
  'connections:manage',
  'connections:switch',
  'assistant-settings:read',
  'assistant-settings:write',
  'pwa:install',
];

/** Server capabilities of an adminCapable process (base + host:*). */
const ADMIN_SERVER_CAPS: Capability[] = [...BASE_CAPS, ...HOST_CAPS];

const SERVER_CONTEXT: ServerRuntimeContext = {
  version: 2,
  admin: true,
  serverCapabilities: ADMIN_SERVER_CAPS,
  publicBaseUrl: 'http://127.0.0.1:3880',
  uiVersion: '0.13.0-beta.1',
  routes: { chat: '/chat', host: '/host' },
  security: {
    hostAdminLoopbackOnly: true,
    requiresHttpsForRemoteConnections: false,
    csrfMode: 'loopback-origin',
  },
};

// ── resolveCapabilities ─────────────────────────────────

describe('resolveCapabilities — electron display mode', () => {
  test('returns the server capabilities unchanged (ALL)', () => {
    const result = resolveCapabilities(ADMIN_SERVER_CAPS, electron);
    expect(sorted(result)).toEqual(sorted(ADMIN_SERVER_CAPS));
  });

  test('ignores connection-granted capabilities — electron already has everything', () => {
    const result = resolveCapabilities(ADMIN_SERVER_CAPS, {
      displayMode: 'electron',
      activeConnection: {
        id: 'r1',
        grantedCapabilities: ['pwa:install'],
      },
    });
    expect(sorted(result)).toEqual(sorted(ADMIN_SERVER_CAPS));
  });
});

describe('resolveCapabilities — admin server + browser (openpalm admin row)', () => {
  test('host:stack:read + browser yields the full server capability set', () => {
    const result = resolveCapabilities(ADMIN_SERVER_CAPS, browser);
    // No Electron-only capabilities are reserved yet, so a host-capable server
    // in a regular browser (`openpalm admin`) keeps everything it granted.
    expect(sorted(result)).toEqual(sorted(ADMIN_SERVER_CAPS));
  });

  test('an admin browser session does not union connection-granted caps', () => {
    const result = resolveCapabilities(ADMIN_SERVER_CAPS, {
      displayMode: 'browser',
      activeConnection: {
        id: 'r1',
        grantedCapabilities: ['pwa:install'],
      },
    });
    expect(sorted(result)).toEqual(sorted(ADMIN_SERVER_CAPS));
  });

  test('admin server + standalone-pwa display strips host:* to the base surface', () => {
    const result = resolveCapabilities(ADMIN_SERVER_CAPS, standalonePwa);
    expect(sorted(result)).toEqual(sorted(BASE_CAPS));
    for (const cap of HOST_CAPS) expect(result).not.toContain(cap);
  });
});

describe('resolveCapabilities — non-admin (base) surface', () => {
  test('browser display keeps the full base surface', () => {
    const result = resolveCapabilities(BASE_CAPS, browser);
    expect(sorted(result)).toEqual(sorted(BASE_CAPS));
  });

  test('standalone-pwa display keeps the same base surface', () => {
    const result = resolveCapabilities(BASE_CAPS, standalonePwa);
    expect(sorted(result)).toEqual(sorted(BASE_CAPS));
  });

  test('activeConnection.grantedCapabilities are unioned in (extension point)', () => {
    const result = resolveCapabilities(BASE_CAPS, {
      displayMode: 'standalone-pwa',
      activeConnection: {
        id: 'r1',
        grantedCapabilities: ['host:logs'],
      },
    });
    expect(result).toEqual(expect.arrayContaining([...BASE_CAPS, 'host:logs']));
  });

  test('granted capabilities are deduplicated against the base surface', () => {
    const result = resolveCapabilities(BASE_CAPS, {
      displayMode: 'browser',
      activeConnection: {
        id: 'r1',
        grantedCapabilities: ['chat', 'assistant-settings:read'],
      },
    });
    expect(new Set(result).size).toBe(result.length);
    expect(sorted(result)).toEqual(sorted(BASE_CAPS));
  });
});

// ── request-local runtime context ─────────────────────────────────────────────

describe('runtime context ownership', () => {
  test('creates the SSR context with browser-baseline capabilities', () => {
    const context = createRuntimeContext(SERVER_CONTEXT);

    expect(context.routes.host).toBe('/host');
    expect(context.publicBaseUrl).toBe('http://127.0.0.1:3880');
    expect(hasCapability(context, 'host:stack:read')).toBe(true);
  });

  test('keeps separate layout instances independent', () => {
    const first = createRuntimeContext(SERVER_CONTEXT);
    const second = createRuntimeContext({
      ...SERVER_CONTEXT,
      admin: false,
      serverCapabilities: BASE_CAPS,
      publicBaseUrl: 'http://remote.example',
      routes: { chat: '/chat' },
    });

    first.routes.host = '/changed';
    expect(second.routes.host).toBeUndefined();
    expect(second.publicBaseUrl).toBe('http://remote.example');
    expect(hasCapability(second, 'host:stack:read')).toBe(false);
  });

  test('recomputes capabilities from browser-only display context after mount', () => {
    const context = createRuntimeContext(SERVER_CONTEXT);
    initializeRuntimeContext(context, SERVER_CONTEXT, standalonePwa);

    expect(context.clientContext.displayMode).toBe('standalone-pwa');
    expect(hasCapability(context, 'chat')).toBe(true);
    expect(hasCapability(context, 'host:stack:read')).toBe(false);
  });
});

// ── integration: computeServerRuntimeContext × resolveCapabilities ───────────
// Pins the effective-capability rows end-to-end through the real
// env → admin → serverCapabilities → effectiveCapabilities pipeline.

describe('capability rows — end-to-end', () => {
  const MODE_ENV_KEYS = ['OP_INSIDE_ELECTRON', 'OP_ENABLE_ADMIN'] as const;
  let savedEnv: Record<string, string | undefined> = {};

  function makeEvent(url = 'http://127.0.0.1:3880/'): RequestEvent {
    const u = new URL(url);
    return {
      url: u,
      request: new Request(u, { headers: { host: u.host } }),
      params: {},
      locals: {},
      route: { id: '/' },
      getClientAddress: () => '127.0.0.1',
      isDataRequest: false,
      isSubRequest: false,
    } as unknown as RequestEvent;
  }

  beforeEach(() => {
    savedEnv = {};
    for (const key of MODE_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MODE_ENV_KEYS) {
      const prev = savedEnv[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  test('admin × electron → ALL', () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    const ctx = computeServerRuntimeContext(makeEvent());
    const effective = resolveCapabilities(ctx.serverCapabilities, electron);
    expect(sorted(effective)).toEqual(sorted(ctx.serverCapabilities));
    expect(effective).toEqual(
      expect.arrayContaining(['chat', 'connections:manage', 'host:setup', 'host:stack:write']),
    );
  });

  test('admin × browser → ALL minus Electron-only', () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const ctx = computeServerRuntimeContext(makeEvent());
    const effective = resolveCapabilities(ctx.serverCapabilities, browser);
    expect(effective).toEqual(
      expect.arrayContaining(['chat', 'connections:manage', 'host:stack:read', 'host:stack:write']),
    );
  });

  test('non-admin × browser → base surface, no host:*', () => {
    const ctx = computeServerRuntimeContext(makeEvent());
    const effective = resolveCapabilities(ctx.serverCapabilities, browser);
    expect(effective).toEqual(
      expect.arrayContaining(['chat', 'connections:manage', 'assistant-settings:write', 'pwa:install']),
    );
    for (const cap of HOST_CAPS) expect(effective).not.toContain(cap);
  });

  test('non-admin × standalone-pwa → base surface', () => {
    const ctx = computeServerRuntimeContext(makeEvent());
    const effective = resolveCapabilities(ctx.serverCapabilities, standalonePwa);
    expect(effective).toEqual(
      expect.arrayContaining(['connections:manage', 'connections:switch', 'chat', 'pwa:install']),
    );
    for (const cap of HOST_CAPS) expect(effective).not.toContain(cap);
  });
});
