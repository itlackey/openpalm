import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { getState, resetState } from '$lib/server/state.js';
import { GET, POST, DELETE } from './+server.js';
import { POST as GENERATE } from './generate/+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-secrets-route-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(method: string, path: string, body?: Record<string, unknown>, token = 'admin-token') {
  const headers: Record<string, string> = {
    'x-request-id': 'req-secrets-1',
  };
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

beforeEach(() => {
  rootDir = makeTempDir();
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');

  const state = getState();
  mkdirSync(state.configDir, { recursive: true });
  mkdirSync(state.vaultDir, { recursive: true });
  mkdirSync(state.dataDir, { recursive: true });
  mkdirSync(state.logsDir, { recursive: true });
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
});

describe('admin secrets routes', () => {
  test('GET lists metadata only for configured backend', async () => {
    const res = await GET(makeEvent('GET', '/admin/secrets'));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      provider: string;
      entries: Array<{ key: string; present: boolean }>;
    };
    expect(body.provider).toBe('plaintext');
    expect(body.entries.some((entry) => entry.key === 'openpalm/admin-token')).toBe(true);
  });

  test('POST writes a secret without returning its value', async () => {
    const res = await POST(makeEvent('POST', '/admin/secrets', {
      key: 'openpalm/custom/test-token',
      value: 'super-secret-value',
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; entry: { key: string }; value?: string };
    expect(body.ok).toBe(true);
    expect(body.entry.key).toBe('openpalm/custom/test-token');
    expect(body.value).toBeUndefined();

    const state = getState();
    const stackEnv = readFileSync(join(state.vaultDir, 'stack', 'stack.env'), 'utf-8');
    expect(stackEnv).toContain('super-secret-value');
  });

  test('POST /generate creates a secret without returning plaintext', async () => {
    const res = await GENERATE(makeEvent('POST', '/admin/secrets/generate', {
      key: 'openpalm/custom/generated',
      length: 24,
    }) as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; entry: { key: string } };
    expect(body.ok).toBe(true);
    expect(body.entry.key).toBe('openpalm/custom/generated');
  });

  test('DELETE removes a secret entry', async () => {
    await POST(makeEvent('POST', '/admin/secrets', {
      key: 'openpalm/custom/removable',
      value: 'to-delete',
    }));

    const res = await DELETE(makeEvent('DELETE', '/admin/secrets?key=openpalm/custom/removable'));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test('assistant token cannot access admin-only secrets routes', async () => {
    const assistantToken = getState().assistantToken;
    const res = await GET(makeEvent('GET', '/admin/secrets', undefined, assistantToken));
    expect(res.status).toBe(401);
  });
});
