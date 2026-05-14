import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { getState } from '$lib/server/state.js';
import { resetState } from '$lib/server/test-helpers.js';
import { GET, POST, DELETE } from './+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-user-vault-route-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEvent(method: string, path: string, body?: Record<string, unknown>, token = 'admin-token') {
  const headers: Record<string, string> = { 'x-request-id': 'req-uv-1' };
  if (token) headers['x-admin-token'] = token;
  if (body) headers['content-type'] = 'application/json';
  return {
    request: new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
  } as Parameters<typeof GET>[0];
}

function hasAkm(): boolean {
  try {
    execFileSync('akm', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const AKM_AVAILABLE = hasAkm();

let rootDir = '';
let originalHome: string | undefined;

beforeEach(() => {
  rootDir = makeTempDir();
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');

  const state = getState();
  mkdirSync(state.configDir, { recursive: true });
  mkdirSync(state.vaultDir, { recursive: true });
  mkdirSync(join(state.vaultDir, 'user'), { recursive: true });
  mkdirSync(state.dataDir, { recursive: true });
  mkdirSync(join(state.dataDir, 'stash'), { recursive: true });
  mkdirSync(state.logsDir, { recursive: true });
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
});

describe('admin user-vault route', () => {
  test('GET returns 401 without admin token', async () => {
    const res = await GET(makeEvent('GET', '/admin/secrets/user-vault', undefined, ''));
    expect(res.status).toBe(401);
  });

  test('GET lists user.env keys without exposing values', async () => {
    const state = getState();
    writeFileSync(join(state.vaultDir, 'user', 'user.env'), 'CUSTOM_KEY=v1\nOTHER_KEY=v2\n');

    const res = await GET(makeEvent('GET', '/admin/secrets/user-vault'));
    expect(res.status).toBe(200);
    const body = await res.json() as { keys: string[]; vaultRef: string };
    expect(body.vaultRef).toBe('vault:user');
    expect(body.keys).toContain('CUSTOM_KEY');
    expect(body.keys).toContain('OTHER_KEY');
    // The response body must not contain any of the values.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('v1');
    expect(raw).not.toContain('v2');
  });

  test('POST writes a key to user.env and reports mirror status', async () => {
    const res = await POST(makeEvent('POST', '/admin/secrets/user-vault', {
      key: 'CUSTOM_TOKEN',
      value: 'secret-payload',
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; key: string; mirrored: boolean };
    expect(body.ok).toBe(true);
    expect(body.key).toBe('CUSTOM_TOKEN');
    // Whether mirror succeeded depends on akm availability — only the
    // user.env write must succeed unconditionally.
    expect(typeof body.mirrored).toBe('boolean');

    const state = getState();
    const content = readFileSync(join(state.vaultDir, 'user', 'user.env'), 'utf-8');
    expect(content).toContain('CUSTOM_TOKEN=');
    expect(content).toContain('secret-payload');
  });

  test('POST rejects invalid key', async () => {
    const res = await POST(makeEvent('POST', '/admin/secrets/user-vault', {
      key: 'bad key with spaces',
      value: 'whatever',
    }));
    expect(res.status).toBe(400);
  });

  test('POST rejects empty value', async () => {
    const res = await POST(makeEvent('POST', '/admin/secrets/user-vault', {
      key: 'KEY',
      value: '',
    }));
    expect(res.status).toBe(400);
  });

  test('DELETE clears a key from user.env', async () => {
    const state = getState();
    writeFileSync(join(state.vaultDir, 'user', 'user.env'), 'KEEP_ME=ok\nDROP_ME=bye\n');

    const res = await DELETE(makeEvent('DELETE', '/admin/secrets/user-vault?key=DROP_ME'));
    expect(res.status).toBe(200);

    const content = readFileSync(join(state.vaultDir, 'user', 'user.env'), 'utf-8');
    expect(content).toContain('KEEP_ME=ok');
    // mergeEnvContent clears the value to empty rather than deleting the line.
    expect(content).toMatch(/DROP_ME=\s*$/m);
  });

  test.skipIf(!AKM_AVAILABLE)('writes are visible to akm vault list after POST', async () => {
    const res = await POST(makeEvent('POST', '/admin/secrets/user-vault', {
      key: 'AKM_INTEGRATION_TEST_KEY',
      value: 'roundtrip-value-' + randomBytes(4).toString('hex'),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { mirrored: boolean };
    expect(body.mirrored).toBe(true);
  });
});
