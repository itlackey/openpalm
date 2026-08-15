/**
 * Tests for GET /api/host/assistant-key — the generated OpenCode Basic-auth
 * key `assistantDirect`'s own copy promises is "shown in the dashboard".
 *
 * Same harness as `api/host/stack/server.vitest.ts` (computed-specifier
 * dynamic import, temp OP_HOME, `resetState`/`OP_ENABLE_ADMIN` capability
 * gating) since this route is guarded identically: `host:stack:read` then
 * `requireAdmin`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { cleanupTempDirs, resetState, seedSecretsEnv, trackDir } from '$lib/server/test-helpers.js';
import { writeSecret } from '@openpalm/lib';

/**
 * The stack.env row a real `applyAccessToggles` writes when assistantDirect is
 * ON: the stored intent. OpenCode Basic auth is always on, so the key is
 * meaningful regardless of the toggle — this fixture only mirrors a realistic
 * published-port row.
 */
const ASSISTANT_DIRECT_ON = 'OP_ACCESS_ASSISTANT_DIRECT=true\n';

type RouteHandler = (event: unknown) => Response | Promise<Response>;
type AssistantKeyRouteModule = { GET: RouteHandler };

/** RED-state-safe loader (same pattern as the host/stack suite). */
async function loadRoute(): Promise<AssistantKeyRouteModule> {
  const specifier = './+server.js';
  return (await import(/* @vite-ignore */ specifier)) as AssistantKeyRouteModule;
}

let homeDir = '';

function makeTempHome(): string {
  const dir = join(tmpdir(), `openpalm-assistant-key-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makeGetEvent(token = 'admin-token'): unknown {
  const url = new URL('http://127.0.0.1:3880/api/host/assistant-key');
  return {
    url,
    request: new Request(url, {
      headers: {
        ...(token ? { cookie: `op_session=${token}` } : {}),
        'x-request-id': 'req-assistant-key-get',
      },
    }),
    params: {},
    locals: { role: token ? 'admin' : null },
    route: { id: '/api/host/assistant-key' },
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
  'OP_BIND_ADDRESS',
  'OP_ASSISTANT_BIND_ADDRESS',
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

describe('GET /api/host/assistant-key', () => {
  test('403 in non-admin mode even with a valid admin session', async () => {
    delete process.env.OP_ENABLE_ADMIN;
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(403);
  });

  test('401 in admin mode without a session cookie', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent(''));
    expect(res.status).toBe(401);
  });

  test('available:true with the toggle off — auth is always on, the key is always live', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    // resetState() -> ensureSecrets() already materialized the secret file;
    // the port not being published does not change what OpenCode requires.
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; password?: string };
    expect(body.available).toBe(true);
    expect(body.password).toBeTruthy();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('available:true with the trailing-newline-stripped key when assistantDirect is on', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    seedSecretsEnv(homeDir, ASSISTANT_DIRECT_ON);
    // Multiple trailing newlines — stripTrailingNewlines must remove all of
    // them (matches the assistant entrypoint's `$(cat file)` and the
    // guardian's own reader).
    writeSecret(homeDir, 'op_opencode_password', 's3cret-key\n\n');
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, username: 'opencode', password: 's3cret-key' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('a stale OPENCODE_AUTH=false row does not withhold the key — the flag is retired', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    // Upgraded homes may carry the row until the v9 migration sweeps it; the
    // route reports what /oc actually sends, which is always the credential.
    seedSecretsEnv(homeDir, 'OP_ACCESS_ASSISTANT_DIRECT=true\nOPENCODE_AUTH=false\n');
    writeSecret(homeDir, 'op_opencode_password', 's3cret-key\n');
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, username: 'opencode', password: 's3cret-key' });
  });

  test('honours the OPENCODE_SERVER_* overrides the shared resolver applies', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    seedSecretsEnv(homeDir, ASSISTANT_DIRECT_ON);
    writeSecret(homeDir, 'op_opencode_password', 'generated-key\n');
    // Re-deriving the credential here instead of calling resolveOpenCodeCredential
    // silently ignored these, so an operator using them was shown a key the
    // assistant rejects — the dashboard's whole reason to exist, inverted.
    process.env.OPENCODE_SERVER_USERNAME = 'custom-user';
    process.env.OPENCODE_SERVER_PASSWORD = 'custom-key';
    try {
      const { GET } = await loadRoute();
      const res = await GET(makeGetEvent());
      expect(await res.json()).toEqual({
        available: true,
        username: 'custom-user',
        password: 'custom-key',
      });
    } finally {
      delete process.env.OPENCODE_SERVER_USERNAME;
      delete process.env.OPENCODE_SERVER_PASSWORD;
    }
  });

  test('preserves meaningful surrounding spaces — never .trim()s the secret', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    seedSecretsEnv(homeDir, ASSISTANT_DIRECT_ON);
    writeSecret(homeDir, 'op_opencode_password', '  spaced key  \n');
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as { available: boolean; password?: string };
    expect(body.available).toBe(true);
    expect(body.password).toBe('  spaced key  ');
  });
});
