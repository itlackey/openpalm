/**
 * Tests for GET /api/host/health — the representative privileged host
 * endpoint of the Phase 4 control-plane split.
 *
 * ALL RED until Phase 4 lands: routes/api/host/health/+server.ts does not
 * exist yet (it is the mechanical move of routes/admin/health/+server.ts).
 * The module is loaded through a computed-specifier dynamic import so
 * svelte-check stays clean while the suite is red.
 *
 * Contract under test:
 *  - Every /api/host/* endpoint carries a SERVER-SIDE requireCapability()
 *    guard in addition to the requireAdmin cookie check (hasCapability() in
 *    the browser is UX only). The guard is
 *    capability-based, not session-based: a VALID admin session in a
 *    non-admin process (whose serverCapabilities carry no host:* capability)
 *    is still refused with 403.
 *  - An admin-capable process (Electron / `openpalm admin`) exposes the
 *    host:* capability set → 200.
 *  - requireAdmin still applies: no session cookie → 401 even when admin-capable.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { cleanupTempDirs, resetState, trackDir } from '$lib/server/test-helpers.js';

type RouteHandler = (event: unknown) => Response | Promise<Response>;
type HostHealthRouteModule = { GET: RouteHandler };

/** RED-state-safe loader (same pattern as the Phase 2 /api/connections suite). */
async function loadRoute(): Promise<HostHealthRouteModule> {
  const specifier = './+server.js';
  return (await import(/* @vite-ignore */ specifier)) as HostHealthRouteModule;
}

function makeTempHome(): string {
  const dir = join(tmpdir(), `openpalm-host-health-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makeGetEvent(token = 'admin-token'): unknown {
  const url = new URL('http://127.0.0.1:3880/api/host/health');
  return {
    url,
    request: new Request(url, {
      headers: {
        ...(token ? { cookie: `op_session=${token}` } : {}),
        'x-request-id': 'req-host-health',
      },
    }),
    params: {},
    locals: { role: token ? 'admin' : null },
    route: { id: '/api/host/health' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  };
}

const ENV_KEYS = [
  'OP_INSIDE_ELECTRON',
  'OP_ENABLE_ADMIN',
  'OP_HOME',
  'OP_OPENCODE_URL',
  'OP_ASSISTANT_URL',
  'OP_ASSISTANT_PORT',
  'OPENCODE_SERVER_PASSWORD',
  'OP_UI_LOGIN_PASSWORD',
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OP_HOME = makeTempHome();
  resetState('admin-token');
  // The health endpoint probes the active assistant endpoint — never let the
  // test suite touch the network.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  cleanupTempDirs();
});

describe('GET /api/host/health — host capability guard', () => {
  test('403 in non-admin mode even with a valid admin session', async () => {
    delete process.env.OP_ENABLE_ADMIN;
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(403);
  });

  test('the non-admin 403 is the capability guard, not generic auth', async () => {
    delete process.env.OP_ENABLE_ADMIN;
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('capability_not_available');
  });

  test('200 in admin mode with a valid admin session', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  test('401 in admin mode without a session cookie (requireAdmin still enforced)', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent(''));
    expect(res.status).toBe(401);
  });
});
