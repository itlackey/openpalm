import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';
import { GET } from './+server.js';

const getProviders = vi.fn();
const getProviderAuth = vi.fn();

vi.mock('$lib/server/helpers.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/helpers.js')>('$lib/server/helpers.js');
  return {
    ...actual,
    getOpenCodeClient: () => ({ getProviders, getProviderAuth }),
  };
});

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-opencode-providers-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    request: new Request('http://localhost/admin/opencode/providers', {
      headers: {
        'x-admin-token': token,
        'x-request-id': 'req-providers',
      },
    }),
  } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  rootDir = makeTempDir();
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('/admin/opencode/providers route', () => {
  test('requires admin token', async () => {
    const res = await GET(makeEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns sanitized provider model lists for the models sheet', async () => {
    getProviders.mockResolvedValueOnce([
      {
        id: 'openai',
        name: 'OpenAI',
        env: ['OPENAI_API_KEY'],
        models: {
          good: { id: 'gpt-4.1-mini', name: 'GPT 4.1 mini' },
          bad: { name: 'Missing ID' },
        },
      },
    ]);
    getProviderAuth.mockResolvedValueOnce({
      openai: [{ type: 'api', label: 'API key' }],
    });

    const res = await GET(makeEvent());
    expect(res.status).toBe(200);

    const body = await res.json() as {
      providers: Array<{ id: string; connected: boolean; modelCount: number; models: Array<{ id: string }> }>;
    };
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({
      id: 'openai',
      connected: true,
      modelCount: 1,
    });
    expect(body.providers[0].models).toEqual([
      {
        id: 'gpt-4.1-mini',
        name: 'GPT 4.1 mini',
        family: '',
        providerID: 'openai',
        status: 'active',
        capabilities: {},
      },
    ]);
  });
});
