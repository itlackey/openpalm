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
 * ON: the stored intent AND the value it generates. `OPENCODE_AUTH` is the half
 * that matters here — it is what compose passes to OpenCode, so it is what
 * decides whether the key means anything, and it is what the route's shared
 * resolver gates on. Seeding the intent alone produced a row no apply can
 * actually produce (see the divergence test at the end of this file).
 */
const ASSISTANT_DIRECT_ON = 'OP_ACCESS_ASSISTANT_DIRECT=true\nOPENCODE_AUTH=true\n';

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

  test('available:false when assistantDirect is off — OpenCode requires no auth, so the stored value would be meaningless', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    // resetState() -> ensureSecrets() already materialized the secret file;
    // the toggle being off must still withhold it.
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
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

  test('withholds the key when OPENCODE_AUTH is off, whatever the stored intent says', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    // A row an apply never writes — hand-edited, or restored from before the
    // intent keys existed. OpenCode is what OPENCODE_AUTH configures, so with it
    // off OpenCode accepts any request and the stored key protects nothing;
    // showing it would advertise a protection that is not in effect. The route
    // gates on the same resolver /oc authenticates with, so the dashboard cannot
    // claim auth is on while the assistant disagrees.
    seedSecretsEnv(homeDir, 'OP_ACCESS_ASSISTANT_DIRECT=true\n');
    writeSecret(homeDir, 'op_opencode_password', 's3cret-key\n');
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
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
