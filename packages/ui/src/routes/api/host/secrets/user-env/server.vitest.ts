/**
 * Tests for the /api/host/secrets/user-env route.
 *
 * The route operates on the akm `env/user` file (`knowledge/env/user.env`)
 * directly. akm (>= 0.8.0) no longer manages individual env entries, so the
 * lib helpers are pure filesystem operations (no `akm` subprocess) — we run
 * them for real here against a temporary OP_HOME. End-to-end coverage of the
 * helpers lives in `packages/lib/src/control-plane/akm-user-env.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';

import { getState } from '$lib/server/state.js';
import { resetState } from '$lib/server/test-helpers.js';
import { readUserEnvFile, userEnvPathSync } from '@openpalm/lib';
import { GET, POST, DELETE } from './+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-user-env-route-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEvent(method: string, path: string, body?: Record<string, unknown>, token = 'admin-token') {
  const headers: Record<string, string> = { 'x-request-id': 'req-ue-1' };
  // Phase 2: x-admin-token header fallback removed; auth flows via op_session cookie.
  if (token) headers.cookie = `op_session=${token}`;
  if (body) headers['content-type'] = 'application/json';
  return {
    request: new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
  } as Parameters<typeof GET>[0];
}

let rootDir = '';
let originalHome: string | undefined;

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_ENABLE_ADMIN = '1';
  rootDir = makeTempDir();
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');

  const state = getState();
  mkdirSync(state.configDir, { recursive: true });
  mkdirSync(state.dataDir, { recursive: true });
  mkdirSync(state.stashDir, { recursive: true });
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
});

describe('admin user-env route', () => {
  test('GET returns 401 without admin token', async () => {
    const res = await GET(makeEvent('GET', '/api/host/secrets/user-env', undefined, ''));
    expect(res.status).toBe(401);
  });

  test('GET lists user env keys without exposing values', async () => {
    await POST(makeEvent('POST', '/api/host/secrets/user-env', { key: 'CUSTOM_KEY', value: 'v1' }));
    await POST(makeEvent('POST', '/api/host/secrets/user-env', { key: 'OTHER_KEY', value: 'v2' }));

    const res = await GET(makeEvent('GET', '/api/host/secrets/user-env'));
    expect(res.status).toBe(200);
    const body = await res.json() as { keys: string[]; envRef: string; provider: string };
    expect(body.provider).toBe('akm');
    expect(body.envRef).toBe('env/user');
    expect(body.keys).toContain('CUSTOM_KEY');
    expect(body.keys).toContain('OTHER_KEY');
    // The response body must not contain any of the values.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('v1');
    expect(raw).not.toContain('v2');
  });

  test('POST writes a key to the user env file', async () => {
    const res = await POST(makeEvent('POST', '/api/host/secrets/user-env', {
      key: 'CUSTOM_TOKEN',
      value: 'secret-payload',
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; key: string };
    expect(body.ok).toBe(true);
    expect(body.key).toBe('CUSTOM_TOKEN');

    const state = getState();
    expect(readUserEnvFile(userEnvPathSync(state)).CUSTOM_TOKEN).toBe('secret-payload');
  });

  test('POST rejects invalid key', async () => {
    const res = await POST(makeEvent('POST', '/api/host/secrets/user-env', {
      key: 'bad key with spaces',
      value: 'whatever',
    }));
    expect(res.status).toBe(400);
  });

  test('POST rejects empty value', async () => {
    const res = await POST(makeEvent('POST', '/api/host/secrets/user-env', {
      key: 'KEY',
      value: '',
    }));
    expect(res.status).toBe(400);
  });

  test('POST rejects a value containing a newline (would corrupt the .env)', async () => {
    const res = await POST(makeEvent('POST', '/api/host/secrets/user-env', {
      key: 'MULTILINE',
      value: 'line1\nline2',
    }));
    expect(res.status).toBe(400);
  });

  test('DELETE removes a key from the user env entirely', async () => {
    await POST(makeEvent('POST', '/api/host/secrets/user-env', { key: 'KEEP_ME', value: 'ok' }));
    await POST(makeEvent('POST', '/api/host/secrets/user-env', { key: 'DROP_ME', value: 'bye' }));

    const res = await DELETE(makeEvent('DELETE', '/api/host/secrets/user-env?key=DROP_ME'));
    expect(res.status).toBe(200);

    const state = getState();
    const parsed = readUserEnvFile(userEnvPathSync(state));
    expect(parsed.KEEP_ME).toBe('ok');
    expect(parsed.DROP_ME).toBeUndefined();
  });

  test('DELETE followed by GET no longer lists the key', async () => {
    await POST(makeEvent('POST', '/api/host/secrets/user-env', { key: 'KEEP_ME', value: 'ok' }));
    await POST(makeEvent('POST', '/api/host/secrets/user-env', { key: 'DROP_ME', value: 'bye' }));
    await DELETE(makeEvent('DELETE', '/api/host/secrets/user-env?key=DROP_ME'));

    const listRes = await GET(makeEvent('GET', '/api/host/secrets/user-env'));
    const body = await listRes.json() as { keys: string[] };
    expect(body.keys).toContain('KEEP_ME');
    expect(body.keys).not.toContain('DROP_ME');
  });

  test('written user env file is mode 0600', async () => {
    await POST(makeEvent('POST', '/api/host/secrets/user-env', { key: 'TOKEN', value: 'x' }));
    const state = getState();
    const path = userEnvPathSync(state);
    // Sanity: the file exists and is readable for the assertion in the lib test.
    expect(readFileSync(path, 'utf-8')).toContain('TOKEN=');
  });
});
