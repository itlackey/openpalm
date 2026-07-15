/**
 * Tests for /api/connections/[id] — Phase 4 connection kind wiring (#486 D2).
 *
 * Mirrors the sibling ../server.vitest.ts harness (computed-specifier dynamic
 * import so svelte-check stays green while PATCH's kind handling doesn't
 * exist yet; makeTestState-backed temp OP_HOME via resetState/trackDir).
 *
 * Contract under test:
 *  - PATCH accepts an optional `kind` in the body and applies it to the
 *    stored connection, re-normalizing a guardian ('openpalm-client-api')
 *    URL to end in /oc (same normalization POST already needs — D2).
 *  - PATCH rejects kind 'local-opencode' (reserved for synthesized entries)
 *    with 400 invalid_connection, same as POST.
 *
 * RED until routes/api/connections/[id]/+server.ts's PATCH reads body.kind —
 * today it is silently ignored (ConnectionPatch has no `kind` field).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { cleanupTempDirs, resetState, trackDir } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';

type RouteHandler = (event: unknown) => Response | Promise<Response>;
type ConnectionIdRouteModule = { PATCH: RouteHandler; DELETE: RouteHandler };

async function loadRoute(): Promise<ConnectionIdRouteModule> {
  const specifier = './+server.js';
  return (await import(/* @vite-ignore */ specifier)) as ConnectionIdRouteModule;
}

function makeTempHome(): string {
  const dir = join(tmpdir(), `openpalm-connections-id-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makePatchEvent(id: string, body: Record<string, unknown>, token = 'admin-token'): unknown {
  const url = new URL(`http://127.0.0.1:3880/api/connections/${id}`);
  return {
    url,
    request: new Request(url, {
      method: 'PATCH',
      headers: {
        cookie: `op_session=${token}`,
        'x-request-id': 'req-connections-patch',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    params: { id },
    locals: { role: 'admin' },
    route: { id: '/api/connections/[id]' },
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
  'OP_UI_HOST_MODE',
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

const EXISTING_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OP_HOME = makeTempHome();
  process.env.OP_UI_HOST_MODE = 'host-ui';
  resetState('admin-token');
  seedEndpointsFile({
    activeId: null,
    endpoints: [
      { id: EXISTING_ID, label: 'Guardian candidate', url: 'http://10.0.0.9:3830' },
    ],
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  cleanupTempDirs();
});

describe('PATCH /api/connections/[id] — connection kind (#486 D2)', () => {
  test('updates kind and re-normalizes a guardian URL to /oc', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(makePatchEvent(EXISTING_ID, { kind: 'openpalm-client-api' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connection: { kind: string; url: string } };
    expect(body.connection.kind).toBe('openpalm-client-api');
    expect(body.connection.url).toBe('http://10.0.0.9:3830/oc');
  });

  test("rejects kind 'local-opencode' with 400", async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(makePatchEvent(EXISTING_ID, { kind: 'local-opencode' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('invalid_connection');
  });

  test('rejects URL userinfo without echoing either credential', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      makePatchEvent(EXISTING_ID, {
        url: 'https://patch-user:patch-password@remote.example',
      })
    );
    const raw = await res.text();
    expect(res.status).toBe(400);
    expect(raw).not.toContain('patch-user');
    expect(raw).not.toContain('patch-password');
  });
});
