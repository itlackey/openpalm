/**
 * Tests for the /admin/secrets/user-vault route.
 *
 * Note: the route operates on the akm `vault:user`
 * store directly. The legacy `vault/user/user.env` mirror is gone — writes
 * go straight to akm via `akm vault set` (stdin mode), and deletes call
 * `akm vault unset`.
 *
 * The akm-vault library helpers spawn the real `akm` binary via `Bun.spawn`,
 * which is unavailable inside vitest's Node worker pool. We therefore mock
 * the helpers exposed by `@openpalm/lib` and assert behavior against an
 * in-memory vault. End-to-end coverage that exercises the real akm binary
 * lives in `packages/lib/src/control-plane/akm-vault.test.ts` (run under
 * `bun test`).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';

// In-memory akm vault state shared by the mocked helpers below. Each test
// resets the map in beforeEach so writes from one test cannot leak into
// another.
const mockAkmVault = new Map<string, string>();
let mockAkmAvailable = true;
let mockVaultPath: string | null = null;

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    AKM_USER_VAULT_REF: 'vault:user',
    ensureAkmUserVault: vi.fn(async () => (mockAkmAvailable ? mockVaultPath : null)),
    readAkmUserVaultFile: vi.fn(() => Object.fromEntries(mockAkmVault)),
    writeAkmVaultKey: vi.fn(async (_state: unknown, key: string, value: string) => {
      if (!mockAkmAvailable) return false;
      mockAkmVault.set(key, value);
      return true;
    }),
    deleteAkmVaultKey: vi.fn(async (_state: unknown, key: string) => {
      if (!mockAkmAvailable) return false;
      mockAkmVault.delete(key);
      return true;
    }),
  };
});

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
  // Phase 2: x-admin-token header fallback removed; auth flows via op_session cookie.
  if (token) headers['cookie'] = `op_session=${token}`;
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
  rootDir = makeTempDir();
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');

  const state = getState();
  mkdirSync(state.configDir, { recursive: true });
  mkdirSync(state.dataDir, { recursive: true });
  mkdirSync(state.stashDir, { recursive: true });
  mkdirSync(join(state.stashDir, 'vaults'), { recursive: true });

  // Reset the mocked akm vault state to a fresh, available, empty store.
  mockAkmVault.clear();
  mockAkmAvailable = true;
  mockVaultPath = join(state.stashDir, 'vaults', 'user.env');
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

  test('GET lists akm vault keys without exposing values', async () => {
    // Note: the GET endpoint enumerates keys from the akm
    // vault:user store, NOT from a legacy `vault/user/user.env` file.
    mockAkmVault.set('CUSTOM_KEY', 'v1');
    mockAkmVault.set('OTHER_KEY', 'v2');

    const res = await GET(makeEvent('GET', '/admin/secrets/user-vault'));
    expect(res.status).toBe(200);
    const body = await res.json() as { keys: string[]; vaultRef: string; provider: string; available: boolean };
    expect(body.provider).toBe('akm');
    expect(body.vaultRef).toBe('vault:user');
    expect(body.available).toBe(true);
    expect(body.keys).toContain('CUSTOM_KEY');
    expect(body.keys).toContain('OTHER_KEY');
    // The response body must not contain any of the values.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('v1');
    expect(raw).not.toContain('v2');
  });

  test('GET reports vault unavailable when akm is missing', async () => {
    mockAkmAvailable = false;
    mockVaultPath = null;

    const res = await GET(makeEvent('GET', '/admin/secrets/user-vault'));
    expect(res.status).toBe(200);
    const body = await res.json() as { keys: string[]; available: boolean };
    expect(body.available).toBe(false);
    expect(body.keys).toEqual([]);
  });

  test('POST writes a key to the akm vault', async () => {
    // Note: POST routes through `akm vault set` (stdin mode).
    // The value never appears on argv. Here we assert the value lands in
    // the in-memory vault store via the mocked helper.
    const res = await POST(makeEvent('POST', '/admin/secrets/user-vault', {
      key: 'CUSTOM_TOKEN',
      value: 'secret-payload',
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; key: string };
    expect(body.ok).toBe(true);
    expect(body.key).toBe('CUSTOM_TOKEN');

    // The key/value MUST have landed in the akm vault.
    expect(mockAkmVault.get('CUSTOM_TOKEN')).toBe('secret-payload');
  });

  test('POST returns 503 when akm is unavailable', async () => {
    mockAkmAvailable = false;
    mockVaultPath = null;

    const res = await POST(makeEvent('POST', '/admin/secrets/user-vault', {
      key: 'CUSTOM_TOKEN',
      value: 'secret-payload',
    }));
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('akm_unavailable');
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

  test('DELETE removes a key from the akm vault entirely', async () => {
    // Note: DELETE routes through `akm vault unset`. The key is
    // expected to disappear from subsequent reads, not linger as an
    // empty-value entry.
    mockAkmVault.set('KEEP_ME', 'ok');
    mockAkmVault.set('DROP_ME', 'bye');

    const res = await DELETE(makeEvent('DELETE', '/admin/secrets/user-vault?key=DROP_ME'));
    expect(res.status).toBe(200);

    expect(mockAkmVault.has('KEEP_ME')).toBe(true);
    expect(mockAkmVault.has('DROP_ME')).toBe(false);
  });

  test('DELETE followed by GET no longer lists the key', async () => {
    mockAkmVault.set('KEEP_ME', 'ok');
    mockAkmVault.set('DROP_ME', 'bye');
    await DELETE(makeEvent('DELETE', '/admin/secrets/user-vault?key=DROP_ME'));

    const listRes = await GET(makeEvent('GET', '/admin/secrets/user-vault'));
    const body = await listRes.json() as { keys: string[] };
    expect(body.keys).toContain('KEEP_ME');
    expect(body.keys).not.toContain('DROP_ME');
  });

  test('DELETE returns 503 when akm is unavailable', async () => {
    mockAkmAvailable = false;
    mockVaultPath = null;

    const res = await DELETE(makeEvent('DELETE', '/admin/secrets/user-vault?key=DROP_ME'));
    expect(res.status).toBe(503);
  });
});
