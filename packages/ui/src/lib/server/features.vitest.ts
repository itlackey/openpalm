/**
 * Tests for lib/server/features.ts — Phase 1 RuntimeContext v2 (issue #509).
 *
 * TDD status:
 *  - `computeServerRuntimeContext(event)` describes the Phase 1 replacement
 *    for the legacy feature flags (plan §6.1).
 *  - The `computeFeatureFlags` characterization block that protected the
 *    `features.admin` derived alias through Phases 1–3 was retired with the
 *    alias itself in Phase 4 (plan Phase 4 step 4: delete when grep finds no
 *    reader — the env → hostMode mapping it pinned is covered by the
 *    `resolveHostMode` tests below).
 *
 * env → hostMode mapping under test (plan Phase 1):
 *   OP_UI_HOST_MODE (explicit) → that mode
 *   else OP_INSIDE_ELECTRON=1  → 'electron-host'
 *   else OP_ENABLE_ADMIN=1     → 'host-ui'
 *   else                       → 'pwa-static' baseline
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Capability, UiHostMode } from '$lib/types.js';
import { computeServerRuntimeContext } from './features.js';

// ── helpers ──────────────────────────────────────────────────────────────────

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

/** The full host:* capability set from plan §6.1. */
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

const MODE_ENV_KEYS = ['OP_UI_HOST_MODE', 'OP_INSIDE_ELECTRON', 'OP_ENABLE_ADMIN'] as const;
let savedEnv: Record<string, string | undefined> = {};

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

// ── env → hostMode mapping (RED until #509 lands) ────────────────────────────

describe('computeServerRuntimeContext — env → hostMode mapping (plan §6.1)', () => {
  const explicitModes: UiHostMode[] = [
    'electron-host',
    'host-ui',
    'assistant-container',
    'pwa-static',
  ];

  for (const mode of explicitModes) {
    test(`OP_UI_HOST_MODE=${mode} maps to hostMode '${mode}'`, () => {
      process.env.OP_UI_HOST_MODE = mode;
      const ctx = computeServerRuntimeContext(makeEvent());
      expect(ctx.hostMode).toBe(mode);
    });
  }

  test("falls back to 'electron-host' when OP_INSIDE_ELECTRON=1 (legacy env)", () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    expect(computeServerRuntimeContext(makeEvent()).hostMode).toBe('electron-host');
  });

  test("falls back to 'host-ui' when OP_ENABLE_ADMIN=1 (legacy env)", () => {
    process.env.OP_ENABLE_ADMIN = '1';
    expect(computeServerRuntimeContext(makeEvent()).hostMode).toBe('host-ui');
  });

  test('OP_INSIDE_ELECTRON wins over OP_ENABLE_ADMIN when both are set', () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    process.env.OP_ENABLE_ADMIN = '1';
    expect(computeServerRuntimeContext(makeEvent()).hostMode).toBe('electron-host');
  });

  test('OP_UI_HOST_MODE takes precedence over the legacy env fallbacks', () => {
    process.env.OP_UI_HOST_MODE = 'pwa-static';
    process.env.OP_INSIDE_ELECTRON = '1';
    process.env.OP_ENABLE_ADMIN = '1';
    expect(computeServerRuntimeContext(makeEvent()).hostMode).toBe('pwa-static');
  });

  test("defaults to the 'pwa-static' baseline when no mode env is set", () => {
    expect(computeServerRuntimeContext(makeEvent()).hostMode).toBe('pwa-static');
  });
});

// ── contract shape (RED until #509 lands) ────────────────────────────────────

describe('computeServerRuntimeContext — ServerRuntimeContext shape (plan §6.1)', () => {
  test('carries contract version 2', () => {
    const ctx = computeServerRuntimeContext(makeEvent());
    expect(ctx.version).toBe(2);
  });

  test('exposes the full contract shape', () => {
    const ctx = computeServerRuntimeContext(makeEvent());
    expect(Array.isArray(ctx.serverCapabilities)).toBe(true);
    expect(typeof ctx.publicBaseUrl).toBe('string');
    expect(typeof ctx.uiVersion).toBe('string');
    expect(typeof ctx.skeletonVersion).toBe('string');
    expect(ctx.routes).toBeTypeOf('object');
    expect(typeof ctx.security.hostAdminLoopbackOnly).toBe('boolean');
    expect(typeof ctx.security.requiresHttpsForRemoteConnections).toBe('boolean');
    expect(['loopback-origin', 'same-site', 'bearer-token']).toContain(ctx.security.csrfMode);
  });

  test("activeConnectionMode is 'single' in assistant-container mode", () => {
    process.env.OP_UI_HOST_MODE = 'assistant-container';
    expect(computeServerRuntimeContext(makeEvent()).activeConnectionMode).toBe('single');
  });

  test("activeConnectionMode is 'multi' in electron-host mode", () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    expect(computeServerRuntimeContext(makeEvent()).activeConnectionMode).toBe('multi');
  });

  test('host admin stays loopback-only in host-capable modes (plan §8.3)', () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    expect(computeServerRuntimeContext(makeEvent()).security.hostAdminLoopbackOnly).toBe(true);
    delete process.env.OP_INSIDE_ELECTRON;
    process.env.OP_ENABLE_ADMIN = '1';
    expect(computeServerRuntimeContext(makeEvent()).security.hostAdminLoopbackOnly).toBe(true);
  });
});

// ── serverCapabilities per hostMode (RED until #509 lands) ───────────────────

describe('computeServerRuntimeContext — serverCapabilities per hostMode (plan §4)', () => {
  test('electron-host: all host, connection and assistant-settings capabilities', () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    const caps = computeServerRuntimeContext(makeEvent()).serverCapabilities;
    expect(caps).toEqual(
      expect.arrayContaining([
        'chat',
        'connections:read',
        'connections:manage',
        'connections:switch',
        'assistant-settings:read',
        'assistant-settings:write',
        ...HOST_CAPS,
      ]),
    );
    // 'connections:single' is the assistant-container marker (plan §6.2) —
    // multi-connection host modes must not carry it.
    expect(caps).not.toContain('connections:single');
  });

  test("host-ui: same host capability set — 'host:stack:read' is load-bearing for resolveCapabilities' browser branch", () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const caps = computeServerRuntimeContext(makeEvent()).serverCapabilities;
    expect(caps).toEqual(
      expect.arrayContaining(['chat', 'host:stack:read', 'host:stack:write', ...HOST_CAPS]),
    );
    expect(caps).not.toContain('connections:single');
  });

  test('assistant-container: connections:single + chat + assistant settings, no host or connection management', () => {
    process.env.OP_UI_HOST_MODE = 'assistant-container';
    const caps = computeServerRuntimeContext(makeEvent()).serverCapabilities;
    expect(caps).toEqual(
      expect.arrayContaining([
        'connections:single',
        'chat',
        'assistant-settings:read',
        'assistant-settings:write',
      ]),
    );
    for (const hostCap of HOST_CAPS) expect(caps).not.toContain(hostCap);
    expect(caps).not.toContain('connections:manage');
  });

  test('pwa-static baseline: connections + chat + pwa:install, nothing privileged', () => {
    const caps = computeServerRuntimeContext(makeEvent()).serverCapabilities;
    expect(caps).toEqual(
      expect.arrayContaining([
        'chat',
        'connections:read',
        'connections:manage',
        'connections:switch',
        'pwa:install',
      ]),
    );
    for (const hostCap of HOST_CAPS) expect(caps).not.toContain(hostCap);
    expect(caps).not.toContain('connections:single');
    expect(caps).not.toContain('assistant-settings:write');
  });
});

// The features.admin alias characterization block lived here through Phases
// 1–3. Phase 4 deleted computeFeatureFlags() with its last readers; the
// legacy env mapping it pinned (OP_INSIDE_ELECTRON / OP_ENABLE_ADMIN) stays
// covered by the resolveHostMode tests above.

// ── clientAppUrl (#511 T5, D8) ────────────────────────────────────────────
// Additive optional field on ServerRuntimeContext — version stays 2. Computed
// for electron-host/host-ui/pwa-static from lib's resolveClientAppPort();
// omitted for assistant-container (no sibling static client there).
// RED reason: the field is `undefined` for every mode pre-implementation
// (features.ts does not set it yet).

describe('computeServerRuntimeContext — clientAppUrl (#511 D8)', () => {
  const CLIENT_ENV_KEYS = ['OP_HOST_CLIENT_PORT'] as const;
  let savedClientEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedClientEnv = {};
    for (const key of CLIENT_ENV_KEYS) {
      savedClientEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of CLIENT_ENV_KEYS) {
      const prev = savedClientEnv[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  test('exposes clientAppUrl for host-capable and pwa-static modes', () => {
    process.env.OP_UI_HOST_MODE = 'host-ui';
    process.env.OP_HOST_CLIENT_PORT = '4444';
    expect(computeServerRuntimeContext(makeEvent()).clientAppUrl).toBe('http://127.0.0.1:4444');

    delete process.env.OP_HOST_CLIENT_PORT;
    expect(computeServerRuntimeContext(makeEvent()).clientAppUrl).toBe('http://127.0.0.1:3890');

    process.env.OP_UI_HOST_MODE = 'electron-host';
    expect(computeServerRuntimeContext(makeEvent()).clientAppUrl).toBe('http://127.0.0.1:3890');

    process.env.OP_UI_HOST_MODE = 'pwa-static';
    expect(computeServerRuntimeContext(makeEvent()).clientAppUrl).toBe('http://127.0.0.1:3890');
  });

  test('omits clientAppUrl in assistant-container mode', () => {
    process.env.OP_UI_HOST_MODE = 'assistant-container';
    expect(computeServerRuntimeContext(makeEvent()).clientAppUrl).toBeUndefined();
  });
});
