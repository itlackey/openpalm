import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';
import { GET } from './+server.js';

const proxy = vi.fn();

vi.mock('$lib/server/helpers.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/helpers.js')>('$lib/server/helpers.js');
  return {
    ...actual,
    getOpenCodeClient: () => ({ proxy }),
  };
});

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
    request: new Request(`http://localhost/api/host/opencode/providers/${providerId}/models`, {
      headers: {
        cookie: `op_session=${token}`,
        'x-request-id': 'req-models',
      },
    }),
  } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_UI_HOST_MODE = 'host-ui';
  rootDir = makeTempDir();
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
});

afterEach(() => {
  delete process.env.OP_UI_HOST_MODE;
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('/api/host/opencode/providers/[id]/models route', () => {
  test('requires admin token', async () => {
    const res = await GET(makeEvent('openai', 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('propagates OpenCode proxy failures', async () => {
    proxy.mockResolvedValueOnce({
      ok: false,
      status: 503,
      code: 'opencode_unavailable',
      message: 'OpenCode is not reachable',
    });

    const res = await GET(makeEvent('openai'));
    expect(res.status).toBe(503);

    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('opencode_unavailable');
    expect(body.message).toBe('OpenCode is not reachable');
  });

  test('filters out models without string ids', async () => {
    proxy.mockResolvedValueOnce({
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
