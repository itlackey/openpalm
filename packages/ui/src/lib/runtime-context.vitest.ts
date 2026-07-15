/**
 * Tests for lib/runtime-context.svelte.ts — RuntimeContext v2 (issue #509),
 * after the "One UI, delete the split" refactor. Per plan §6.2 this module is
 * the ONLY place capability logic lives, exporting
 * `resolveCapabilities(serverCaps, clientCtx)`, `hasCapability(cap)` and the
 * reactive `runtimeContext` store.
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
import type { Capability, ClientContext } from '$lib/types.js';
import {
  hasCapability,
  initializeServerRuntimeContext,
  resolveCapabilities,
  runtimeContext,
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

// ── resolveCapabilities — plan §6.2, exactly ─────────────────────────────────

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
  test('host:stack:read + browser yields everything minus Electron-only caps (none reserved yet)', () => {
    const result = resolveCapabilities(ADMIN_SERVER_CAPS, browser);
    // isElectronOnlyCap() is reserved and returns false for every capability
    // today, so "ALL minus Electron-only" is currently the full set.
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

  test('activeConnection.grantedCapabilities are unioned in (plan §4.3 extension point)', () => {
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

// ── hasCapability + runtimeContext store ─────────────────────────────────────

describe('hasCapability — reads the reactive runtimeContext store', () => {
  let before: Capability[];

  beforeEach(() => {
    before = runtimeContext.effectiveCapabilities;
  });

  afterEach(() => {
    runtimeContext.effectiveCapabilities = before;
  });

  test('runtimeContext exposes an effectiveCapabilities array', () => {
    expect(Array.isArray(runtimeContext.effectiveCapabilities)).toBe(true);
  });

  test('true for a capability present in effectiveCapabilities', () => {
    runtimeContext.effectiveCapabilities = ['chat', 'connections:read'];
    expect(hasCapability('chat')).toBe(true);
    expect(hasCapability('connections:read')).toBe(true);
  });

  test('false for a capability absent from effectiveCapabilities', () => {
    runtimeContext.effectiveCapabilities = ['chat'];
    expect(hasCapability('host:setup')).toBe(false);
    expect(hasCapability('connections:manage')).toBe(false);
  });
});

// ── initializeServerRuntimeContext — review 2026-07-10 K2 ────────────────────
// The server half must be callable synchronously (script-body time, not
// onMount) and produce a correct effectiveCapabilities set against the
// store's current clientContext WITHOUT requiring a ClientContext argument —
// that's what lets it run during SSR, before the browser-only client half
// (detectClientDisplayMode) has anything to contribute.

describe('initializeServerRuntimeContext (review 2026-07-10 K2 — SSR-safe server-half init)', () => {
  let savedContext: typeof runtimeContext.clientContext;
  let savedEffective: Capability[];

  beforeEach(() => {
    savedContext = runtimeContext.clientContext;
    savedEffective = runtimeContext.effectiveCapabilities;
    runtimeContext.clientContext = { displayMode: 'browser' };
  });

  afterEach(() => {
    runtimeContext.clientContext = savedContext;
    runtimeContext.effectiveCapabilities = savedEffective;
  });

  test('populates serverCapabilities/admin/routes from the server context', () => {
    initializeServerRuntimeContext({
      version: 2,
      admin: true,
      serverCapabilities: ADMIN_SERVER_CAPS,
      publicBaseUrl: 'http://127.0.0.1:3880',
      uiVersion: '0.13.0-beta.1',
      skeletonVersion: '0.13.0-beta.1',
      routes: { chat: '/chat', host: '/host' },
      security: {
        hostAdminLoopbackOnly: true,
        requiresHttpsForRemoteConnections: false,
        csrfMode: 'loopback-origin',
      },
    });
    expect(runtimeContext.admin).toBe(true);
    expect(runtimeContext.routes.host).toBe('/host');
  });

  test('derives effectiveCapabilities against the CURRENT clientContext (no clientCtx argument needed)', () => {
    runtimeContext.clientContext = { displayMode: 'browser' };
    initializeServerRuntimeContext({
      version: 2,
      admin: true,
      serverCapabilities: ADMIN_SERVER_CAPS,
      publicBaseUrl: '',
      uiVersion: '',
      skeletonVersion: '',
      routes: {},
      security: {
        hostAdminLoopbackOnly: true,
        requiresHttpsForRemoteConnections: false,
        csrfMode: 'loopback-origin',
      },
    });
    // host:stack:read is in the fixture's ADMIN_SERVER_CAPS — this is exactly
    // what SSR needs available for the admin-button check (hasCapability)
    // to render true in the FIRST server-rendered HTML, before onMount runs.
    expect(hasCapability('host:stack:read')).toBe(true);
  });

  test('never writes the request-derived publicBaseUrl into the shared store (PR #562 review)', () => {
    // publicBaseUrl comes from event.url.origin — the ONE per-request field in
    // ServerRuntimeContext. During SSR this store is process-global under
    // adapter-node, so writing it would leak one request's Host-derived origin
    // into every later reader. SSR chrome needs capabilities/admin/routes
    // only; the browser sets publicBaseUrl in onMount (per-tab store — safe).
    const before = runtimeContext.publicBaseUrl;
    initializeServerRuntimeContext({
      version: 2,
      admin: true,
      serverCapabilities: ADMIN_SERVER_CAPS,
      publicBaseUrl: 'http://attacker-controlled-host-header.example',
      uiVersion: '',
      skeletonVersion: '',
      routes: {},
      security: {
        hostAdminLoopbackOnly: true,
        requiresHttpsForRemoteConnections: false,
        csrfMode: 'loopback-origin',
      },
    });
    expect(runtimeContext.publicBaseUrl).toBe(before);
    // The env-derived halves must still land (that's K2's whole point).
    expect(runtimeContext.admin).toBe(true);
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
