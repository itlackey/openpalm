/**
 * Tests for lib/runtime-context.svelte.ts — Phase 1 RuntimeContext v2 (issue #509).
 *
 * ALL RED until the implementation lands: the module under test does not exist
 * yet. Per plan §6.2 it must be the ONLY place capability logic lives, exporting
 * `resolveCapabilities(serverCaps, clientCtx)`, `hasCapability(cap)` and the
 * reactive `runtimeContext` store.
 *
 * Pins the full effective-capability matrix from plan §4.3:
 *   electron-host + electron            → ALL server capabilities
 *   host-ui + browser                   → ALL minus Electron-only (none reserved yet)
 *   connections:single (+ any display)  → chat + assistant-settings:*
 *   pwa baseline (+ any display)        → connections:* + chat + pwa:install
 *   activeConnection.grantedCapabilities → unioned in (deduped)
 *
 * Runs in the node ("server") vitest project; the `.svelte.ts` module is
 * compiled by the Svelte plugin, so its runes work here (same pattern as
 * lib/setup/setup-state.vitest.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Capability, ClientContext } from '$lib/types.js';
import { hasCapability, resolveCapabilities, runtimeContext } from './runtime-context.svelte.js';
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

/** Server capabilities of a host-capable process (electron-host / host-ui). */
const HOST_SERVER_CAPS: Capability[] = [
  'chat',
  'connections:read',
  'connections:manage',
  'connections:switch',
  'assistant-settings:read',
  'assistant-settings:write',
  ...HOST_CAPS,
];

/** Server capabilities in assistant-container mode (single locked connection). */
const ASSISTANT_CONTAINER_CAPS: Capability[] = [
  'connections:single',
  'chat',
  'assistant-settings:read',
  'assistant-settings:write',
];

/** The pwa-static baseline. */
const PWA_BASELINE_CAPS: Capability[] = [
  'chat',
  'connections:read',
  'connections:manage',
  'connections:switch',
  'pwa:install',
];

// ── resolveCapabilities — plan §6.2, exactly ─────────────────────────────────

describe('resolveCapabilities — electron display mode', () => {
  test('returns the server capabilities unchanged (ALL)', () => {
    const result = resolveCapabilities(HOST_SERVER_CAPS, electron);
    expect(sorted(result)).toEqual(sorted(HOST_SERVER_CAPS));
  });

  test('ignores connection-granted capabilities — electron already has everything', () => {
    const result = resolveCapabilities(HOST_SERVER_CAPS, {
      displayMode: 'electron',
      activeConnection: {
        kind: 'remote-opencode',
        id: 'r1',
        grantedCapabilities: ['pwa:install'],
      },
    });
    expect(sorted(result)).toEqual(sorted(HOST_SERVER_CAPS));
  });
});

describe('resolveCapabilities — host-capable server + browser (host-ui row)', () => {
  test('host:stack:read + browser yields everything minus Electron-only caps (none reserved yet)', () => {
    const result = resolveCapabilities(HOST_SERVER_CAPS, browser);
    // isElectronOnlyCap() is reserved and returns false for every capability
    // today, so "ALL minus Electron-only" is currently the full set.
    expect(sorted(result)).toEqual(sorted(HOST_SERVER_CAPS));
  });

  test('a host-capable browser session does not union connection-granted caps', () => {
    const result = resolveCapabilities(HOST_SERVER_CAPS, {
      displayMode: 'browser',
      activeConnection: {
        kind: 'remote-opencode',
        id: 'r1',
        grantedCapabilities: ['pwa:install'],
      },
    });
    expect(sorted(result)).toEqual(sorted(HOST_SERVER_CAPS));
  });

  test('host-capable server + standalone-pwa display falls back to connection management (plan §4.2)', () => {
    const result = resolveCapabilities(HOST_SERVER_CAPS, standalonePwa);
    expect(sorted(result)).toEqual(
      sorted(['chat', 'connections:read', 'connections:manage', 'connections:switch']),
    );
  });
});

describe('resolveCapabilities — connections:single (assistant-container row)', () => {
  test('browser display yields exactly chat + assistant-settings:*', () => {
    const result = resolveCapabilities(ASSISTANT_CONTAINER_CAPS, browser);
    expect(sorted(result)).toEqual(
      sorted(['chat', 'assistant-settings:read', 'assistant-settings:write']),
    );
  });

  test('standalone-pwa display yields the same set', () => {
    const result = resolveCapabilities(ASSISTANT_CONTAINER_CAPS, standalonePwa);
    expect(sorted(result)).toEqual(
      sorted(['chat', 'assistant-settings:read', 'assistant-settings:write']),
    );
  });

  test("the 'connections:single' marker itself is not an effective capability", () => {
    const result = resolveCapabilities(ASSISTANT_CONTAINER_CAPS, browser);
    expect(result).not.toContain('connections:single');
  });
});

describe('resolveCapabilities — pwa-static baseline row', () => {
  test('browser display keeps connections:* + chat + pwa:install', () => {
    const result = resolveCapabilities(PWA_BASELINE_CAPS, browser);
    expect(sorted(result)).toEqual(sorted(PWA_BASELINE_CAPS));
  });

  test('standalone-pwa display keeps the same baseline', () => {
    const result = resolveCapabilities(PWA_BASELINE_CAPS, standalonePwa);
    expect(sorted(result)).toEqual(sorted(PWA_BASELINE_CAPS));
  });

  test('non-baseline capabilities are filtered out unless connection-granted', () => {
    const result = resolveCapabilities(
      [...PWA_BASELINE_CAPS, 'assistant-settings:write'],
      browser,
    );
    expect(result).not.toContain('assistant-settings:write');
  });

  test('activeConnection.grantedCapabilities are unioned in (plan §4.3 extension point)', () => {
    const result = resolveCapabilities(PWA_BASELINE_CAPS, {
      displayMode: 'standalone-pwa',
      activeConnection: {
        kind: 'remote-opencode',
        id: 'r1',
        grantedCapabilities: ['assistant-settings:read', 'assistant-settings:write'],
      },
    });
    expect(result).toEqual(
      expect.arrayContaining([
        ...PWA_BASELINE_CAPS,
        'assistant-settings:read',
        'assistant-settings:write',
      ]),
    );
  });

  test('granted capabilities are deduplicated against the baseline', () => {
    const result = resolveCapabilities(PWA_BASELINE_CAPS, {
      displayMode: 'browser',
      activeConnection: {
        kind: 'remote-opencode',
        id: 'r1',
        grantedCapabilities: ['chat', 'assistant-settings:read'],
      },
    });
    expect(new Set(result).size).toBe(result.length);
    expect(sorted(result)).toEqual(sorted([...PWA_BASELINE_CAPS, 'assistant-settings:read']));
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

// ── integration: computeServerRuntimeContext × resolveCapabilities ───────────
// Pins the four rows of the plan §4.3 matrix end-to-end through the real
// env → hostMode → serverCapabilities → effectiveCapabilities pipeline.

describe('capability matrix — plan §4.3 rows end-to-end', () => {
  const MODE_ENV_KEYS = ['OP_UI_HOST_MODE', 'OP_INSIDE_ELECTRON', 'OP_ENABLE_ADMIN'] as const;
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

  test('electron-host × electron → ALL', () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    const ctx = computeServerRuntimeContext(makeEvent());
    const effective = resolveCapabilities(ctx.serverCapabilities, electron);
    expect(sorted(effective)).toEqual(sorted(ctx.serverCapabilities));
    expect(effective).toEqual(
      expect.arrayContaining(['chat', 'connections:manage', 'host:setup', 'host:stack:write']),
    );
  });

  test('host-ui × browser → ALL minus Electron-only', () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const ctx = computeServerRuntimeContext(makeEvent());
    const effective = resolveCapabilities(ctx.serverCapabilities, browser);
    expect(effective).toEqual(
      expect.arrayContaining(['chat', 'connections:manage', 'host:stack:read', 'host:stack:write']),
    );
  });

  test('assistant-container × browser → chat + assistant-settings only', () => {
    process.env.OP_UI_HOST_MODE = 'assistant-container';
    const ctx = computeServerRuntimeContext(makeEvent());
    const effective = resolveCapabilities(ctx.serverCapabilities, browser);
    expect(sorted(effective)).toEqual(
      sorted(['chat', 'assistant-settings:read', 'assistant-settings:write']),
    );
    for (const cap of HOST_CAPS) expect(effective).not.toContain(cap);
    expect(effective).not.toContain('connections:manage');
  });

  test('pwa-static × standalone-pwa → connections + chat + pwa:install', () => {
    process.env.OP_UI_HOST_MODE = 'pwa-static';
    const ctx = computeServerRuntimeContext(makeEvent());
    const effective = resolveCapabilities(ctx.serverCapabilities, standalonePwa);
    expect(effective).toEqual(
      expect.arrayContaining(['connections:manage', 'connections:switch', 'chat', 'pwa:install']),
    );
    for (const cap of HOST_CAPS) expect(effective).not.toContain(cap);
    expect(effective).not.toContain('assistant-settings:write');
  });
});
