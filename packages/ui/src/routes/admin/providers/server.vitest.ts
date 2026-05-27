/**
 * Tests for GET /admin/providers.
 *
 * Asserts:
 *  - 401 without auth
 *  - 200 + stable response shape: { available, providers[], stats, defaultModels }
 *  - available=true when the OpenCode server is reachable
 *  - available=false when OpenCode is down (graceful degradation)
 *  - providers is always an array (never undefined)
 */
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';
import type { ProviderPageState } from '$lib/types/providers.js';

const mockPageState: ProviderPageState = {
  available: true,
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      connected: true,
      enabled: true,
      credentialType: 'api',
      models: [],
    } as unknown as import('$lib/types/providers.js').ProviderView,
  ],
  defaultModels: {},
  allowlistActive: false,
  providerCountLabel: '1 provider',
  stats: { total: 1, connected: 1, configured: 1, disabled: 0 },
};

vi.mock('$lib/server/opencode/catalog.js', () => ({
  loadProviderPage: vi.fn(async () => mockPageState),
}));

import { GET } from './+server.js';
import { loadProviderPage } from '$lib/server/opencode/catalog.js';

function makeEvent(token = 'admin-token') {
  return {
    request: new Request('http://localhost/admin/providers', {
      headers: {
        cookie: token ? `op_session=${token}` : '',
        'x-request-id': 'req-providers-1',
      },
    }),
  } as Parameters<typeof GET>[0];
}

let rootDir = '';
let originalHome: string | undefined;

beforeEach(() => {
  rootDir = join(tmpdir(), `openpalm-providers-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(rootDir, { recursive: true });
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
  vi.mocked(loadProviderPage).mockResolvedValue(mockPageState);
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('GET /admin/providers', () => {
  test('returns 401 without auth', async () => {
    const res = await GET(makeEvent(''));
    expect(res.status).toBe(401);
  });

  test('returns 200 with valid cookie', async () => {
    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
  });

  test('response shape: available (boolean), providers (array), stats, defaultModels', async () => {
    const res = await GET(makeEvent());
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.available).toBe('boolean');
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.stats).toBeDefined();
    expect(body.defaultModels).toBeDefined();
  });

  test('stats shape: total and connected are numbers', async () => {
    const res = await GET(makeEvent());
    const body = await res.json() as { stats: Record<string, unknown> };
    expect(typeof body.stats.total).toBe('number');
    expect(typeof body.stats.connected).toBe('number');
  });

  test('providers is always an array even when empty', async () => {
    vi.mocked(loadProviderPage).mockResolvedValue({ ...mockPageState, providers: [] });
    const res = await GET(makeEvent());
    const body = await res.json() as { providers: unknown };
    expect(Array.isArray(body.providers)).toBe(true);
  });

  test('available=false is surfaced when OpenCode is down', async () => {
    vi.mocked(loadProviderPage).mockResolvedValue({ ...mockPageState, available: false, providers: [] });
    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as { available: boolean };
    expect(body.available).toBe(false);
  });
});
