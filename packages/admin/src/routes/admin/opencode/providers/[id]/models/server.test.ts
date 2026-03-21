import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/state.js';
import { GET } from './+server.js';

vi.mock('$lib/opencode/client.server.js', () => ({
  proxyToOpenCode: vi.fn(),
}));

import { proxyToOpenCode } from '$lib/opencode/client.server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-opencode-model-list-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(providerId = 'openai', token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    params: { id: providerId },
    request: new Request(`http://localhost/admin/opencode/providers/${providerId}/models`, {
      headers: {
        'x-admin-token': token,
        'x-request-id': 'req-models',
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

describe('/admin/opencode/providers/[id]/models route', () => {
  test('requires admin token', async () => {
    const res = await GET(makeEvent('openai', 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('filters out models without string ids', async () => {
    vi.mocked(proxyToOpenCode).mockResolvedValueOnce({
      ok: true,
      data: {
        all: [
          {
            id: 'openai',
            models: {
              good: { id: 'gpt-4.1-mini', name: 'GPT 4.1 mini' },
              bad: { name: 'Missing ID' },
            },
          },
        ],
      },
    });

    const res = await GET(makeEvent('openai'));
    expect(res.status).toBe(200);

    const body = await res.json() as { models: Array<{ id: string; name: string }> };
    expect(body.models).toEqual([{ id: 'gpt-4.1-mini', name: 'GPT 4.1 mini', family: '', providerID: 'openai', status: 'active', capabilities: {} }]);
  });
});
