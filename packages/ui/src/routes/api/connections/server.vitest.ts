/**
 * Tests for /api/connections — Phase 2 connection management API (plan
 * ui-runtime-modes-plan.md Phase 2, issue #486).
 *
 * ALL RED until the implementation lands: routes/api/connections/+server.ts
 * does not exist yet. The module is loaded through a computed-specifier
 * dynamic import so svelte-check stays clean while the suite is red; the
 * tests fail at runtime with a module-resolution error until Phase 2 lands.
 *
 * Contract under test (plan §6.4 API namespace table + §8.5):
 *  - /api/connections is guarded SERVER-SIDE by the `connections:manage`
 *    capability. `hasCapability()` in the browser is UX only — the security
 *    boundary is this route.
 *  - `connections:manage` is a BASE capability present in EVERY process (the
 *    browser owns connections uniformly), so the guard passes regardless of
 *    admin capability; a valid admin session cookie is still required (401
 *    otherwise). Connection management is reachable without any host-admin
 *    mode (Phase 2 acceptance: "connection management reachable without /admin").
 *  - Stored connection passwords are never serialized into responses
 *    (parity with the /admin/endpoints publish() contract).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { cleanupTempDirs, resetState, trackDir } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';

type RouteHandler = (event: unknown) => Response | Promise<Response>;
type ConnectionsRouteModule = { GET: RouteHandler; POST: RouteHandler };

/**
 * RED-state-safe loader: the computed specifier keeps svelte-check green
 * while the route module does not exist yet (same pattern as the Phase 1.5
 * red suite). Once routes/api/connections/+server.ts lands this resolves
 * exactly like a static `import { GET, POST } from './+server.js'`.
 */
async function loadRoute(): Promise<ConnectionsRouteModule> {
  const specifier = './+server.js';
  return (await import(/* @vite-ignore */ specifier)) as ConnectionsRouteModule;
}

function makeTempHome(): string {
  const dir = join(tmpdir(), `openpalm-connections-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makeGetEvent(token = 'admin-token'): unknown {
  const url = new URL('http://127.0.0.1:3880/api/connections');
  return {
    url,
    request: new Request(url, {
      headers: {
        cookie: `op_session=${token}`,
        'x-request-id': 'req-connections-list',
      },
    }),
    params: {},
    locals: { role: 'admin' },
    route: { id: '/api/connections' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  };
}

function makePostEvent(body: Record<string, unknown>, token = 'admin-token'): unknown {
  const url = new URL('http://127.0.0.1:3880/api/connections');
  return {
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        cookie: `op_session=${token}`,
        'x-request-id': 'req-connections-create',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    params: {},
    locals: { role: 'admin' },
    route: { id: '/api/connections' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  };
}

/** Seed config/endpoints.json directly (the on-disk schema is NOT renamed). */
function seedEndpointsFile(payload: unknown): void {
  const configDir = getState().configDir;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'endpoints.json'), JSON.stringify(payload), { mode: 0o600 });
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
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  cleanupTempDirs();
});

describe('GET /api/connections — connections:manage guard (plan §6.4, §8.5)', () => {
  test('401 without a valid session cookie (requireAdmin still enforced)', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent(''));
    expect(res.status).toBe(401);
  });

  test('200 in a non-admin process with a valid admin session (base capability present)', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
  });

  test('reachable in an admin process too — no host-admin mode required (Phase 2 acceptance)', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
  });

  test('lists the env-derived default connection', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Tolerate either payload key — the internal rename is "connection"
    // language, but the response delegates to the same server module.
    const list = (body.connections ?? body.endpoints) as Array<{ id: string }>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((entry) => entry.id === 'default')).toBe(true);
  });

  test('never serializes stored connection passwords', async () => {
    seedEndpointsFile({
      activeId: null,
      endpoints: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          label: 'Remote',
          url: 'http://legacy-user:legacy-url-password@10.0.0.9:3800',
          password: 'super-secret-pw',
        },
      ],
    });
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('super-secret-pw');
    expect(raw).not.toContain('legacy-user');
    expect(raw).not.toContain('legacy-url-password');
    expect(raw).toContain('http://10.0.0.9:3800');
  });
});

describe('POST /api/connections — connections:manage guard on writes', () => {
  test('401 without a valid session cookie (requireAdmin still enforced)', async () => {
    const { POST } = await loadRoute();
    const res = await POST(makePostEvent({ label: 'Remote', url: 'http://10.0.0.9:3800' }, ''));
    expect(res.status).toBe(401);
  });

  test('creates a connection in a non-admin process with a valid session', async () => {
    const { POST } = await loadRoute();
    const res = await POST(makePostEvent({ label: 'Remote', url: 'http://10.0.0.9:3800' }));
    expect(res.status).toBe(201);
  });

  test('rejects URL userinfo without echoing either credential in the API response', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      makePostEvent({
        label: 'Unsafe',
        url: 'https://api-user:api-password@remote.example',
      })
    );
    const raw = await res.text();
    expect(res.status).toBe(400);
    expect(raw).not.toContain('api-user');
    expect(raw).not.toContain('api-password');
  });
});
