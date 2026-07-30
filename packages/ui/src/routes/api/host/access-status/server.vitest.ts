/**
 * Tests for GET /api/host/access-status — "what URL do I open on my phone,
 * and does it work?" (Phase 2 of the LAN-access review).
 *
 * Docker is never actually invoked: `OP_DOCKER_BIN` is pointed at a
 * nonexistent binary so `composePs`'s real `execFile` call fails FAST
 * (ENOENT, ~ms) instead of waiting out a real `docker` binary's ~1s
 * connection-refused timeout against a socket that does not exist in this
 * sandbox — the endpoint's own contract ("degrade to null, never throw") is
 * exercised for real rather than mocked away.
 *
 * `checkExistingUiInstance`'s self-probe goes through the global `fetch`, so
 * that alone is stubbed per test to drive the three reachability outcomes.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { cleanupTempDirs, resetState, seedSecretsEnv, trackDir } from '$lib/server/test-helpers.js';

type RouteHandler = (event: unknown) => Response | Promise<Response>;
type AccessStatusRouteModule = { GET: RouteHandler };

/** RED-state-safe loader (same pattern as the neighbouring /api/host/stack suite). */
async function loadRoute(): Promise<AccessStatusRouteModule> {
  const specifier = './+server.js';
  return (await import(/* @vite-ignore */ specifier)) as AccessStatusRouteModule;
}

let homeDir = '';

function makeTempHome(): string {
  const dir = join(tmpdir(), `openpalm-access-status-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makeGetEvent(token = 'admin-token'): unknown {
  const url = new URL('http://127.0.0.1:3880/api/host/access-status');
  return {
    url,
    request: new Request(url, {
      headers: {
        ...(token ? { cookie: `op_session=${token}` } : {}),
        'x-request-id': 'req-access-status',
      },
    }),
    params: {},
    locals: { role: token ? 'admin' : null },
    route: { id: '/api/host/access-status' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  };
}

const ENV_KEYS = [
  'OP_INSIDE_ELECTRON',
  'OP_ENABLE_ADMIN',
  'OP_HOME',
  'OP_UI_LOGIN_PASSWORD',
  'OP_DOCKER_BIN',
  'OP_UI_PORT',
  'OP_PROJECT_NAME',
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  homeDir = makeTempHome();
  process.env.OP_HOME = homeDir;
  process.env.OP_ENABLE_ADMIN = '1';
  // See the module doc comment: fail composePs's execFile call fast instead
  // of waiting out a real `docker` binary against a socket this sandbox does
  // not have.
  process.env.OP_DOCKER_BIN = '/nonexistent-openpalm-docker-test-binary';
  resetState('admin-token');
  // Default: nothing answers the self-probe port.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
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

describe('GET /api/host/access-status — capability + auth guard', () => {
  test('403 in non-admin mode even with a valid admin session', async () => {
    delete process.env.OP_ENABLE_ADMIN;
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('capability_not_available');
  });

  test('401 in admin mode without a session cookie', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent(''));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/host/access-status — the shape of the answer', () => {
  test('a fresh install: closed intent, unreachable Docker degrades to null, port defaults to 3800', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.intent).toEqual({
      networkAccess: false,
      assistantDirect: false,
      guardianNetwork: false,
      guardianOpenaiApi: false,
    });
    // OP_DOCKER_BIN points nowhere — composePs cannot even start Docker, so
    // BOTH containers must read as unknown, never as "down".
    expect(body.actual).toEqual({ assistant: null, guardian: null });
    expect(body.port).toBe(3800);
  });

  test('urls: the derived <project>.local name always comes first', async () => {
    seedSecretsEnv(homeDir, 'OP_PROJECT_NAME=my_lab\n');
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.urls as string[])[0]).toBe('http://my-lab.local:3800');
  });

  test('a custom OP_UI_PORT is reflected in both `port` and every URL', async () => {
    seedSecretsEnv(homeDir, 'OP_UI_PORT=4200\n');
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.port).toBe(4200);
    for (const url of body.urls as string[]) expect(url.endsWith(':4200')).toBe(true);
  });

  test('reachable: match — the self-probe hits OUR non-admin container UI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ admin: false }) }),
    );
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reachable).toEqual({ status: 'match', ok: true });
  });

  test('reachable: mismatch — something answers the port but is not our non-admin UI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ admin: true }) }),
    );
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reachable).toEqual({ status: 'mismatch', ok: false });
  });

  test('reachable: absent — nothing answers the port (the default stub)', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reachable).toEqual({ status: 'absent', ok: false });
  });

  test('intent reflects a stored networkAccess:true toggle', async () => {
    seedSecretsEnv(homeDir, 'OP_ACCESS_NETWORK=true\nOP_UI_BIND_ADDRESS=0.0.0.0\n');
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.intent as Record<string, boolean>).networkAccess).toBe(true);
  });
});
