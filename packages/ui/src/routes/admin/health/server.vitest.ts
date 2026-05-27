/**
 * Tests for GET /admin/health.
 *
 * Asserts:
 *  - 401 without auth
 *  - 200 + stable response shape: { ok, opencode, endpoint }
 *  - opencode=true when the upstream probe succeeds
 *  - opencode=false when the upstream probe fails (network error or non-2xx)
 *  - Always 200 (not 503) when authenticated — callers decide how to surface unavailability
 */
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';

const mockEndpoint = {
  id: 'default',
  label: 'Local assistant',
  url: 'http://127.0.0.1:4096',
  isDefault: true,
  username: '',
  password: '',
};

vi.mock('$lib/server/endpoints.js', () => ({
  getActiveEndpoint: vi.fn(() => mockEndpoint),
}));

import { GET } from './+server.js';

function makeEvent(token = 'admin-token') {
  return {
    request: new Request('http://localhost/admin/health', {
      headers: {
        cookie: token ? `op_session=${token}` : '',
        'x-request-id': 'req-health-1',
      },
    }),
  } as Parameters<typeof GET>[0];
}

let rootDir = '';
let originalHome: string | undefined;

beforeEach(() => {
  rootDir = join(tmpdir(), `openpalm-health-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(rootDir, { recursive: true });
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('GET /admin/health', () => {
  test('returns 401 without auth', async () => {
    const res = await GET(makeEvent(''));
    expect(res.status).toBe(401);
  });

  test('returns 200 with valid cookie', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
  });

  test('response always has ok:true when authenticated', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const res = await GET(makeEvent());
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  test('response shape includes opencode (boolean) and endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const res = await GET(makeEvent());
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.opencode).toBe('boolean');
    expect(body.endpoint).toBeDefined();
    const ep = body.endpoint as Record<string, unknown>;
    expect(typeof ep.id).toBe('string');
    expect(typeof ep.label).toBe('string');
    expect(typeof ep.url).toBe('string');
    expect(typeof ep.isDefault).toBe('boolean');
  });

  test('opencode=true when upstream /health probe succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const res = await GET(makeEvent());
    const body = await res.json() as { opencode: boolean };
    expect(body.opencode).toBe(true);
  });

  test('opencode=false when upstream /health probe fails (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as { opencode: boolean };
    expect(body.opencode).toBe(false);
  });

  test('opencode=false when upstream /health returns non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const res = await GET(makeEvent());
    const body = await res.json() as { opencode: boolean };
    expect(body.opencode).toBe(false);
  });

  test('always returns 200 (not 503) when authenticated, even if opencode is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
  });
});
