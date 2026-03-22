import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { getState, resetState } from '$lib/server/state.js';
import { GET, POST } from './+server.js';
import { stringify as yamlStringify } from 'yaml';

vi.mock('$lib/opencode/client.server.js', () => ({
  getOpenCodeConfig: vi.fn(),
  proxyToOpenCode: vi.fn(),
}));

import { getOpenCodeConfig, proxyToOpenCode } from '$lib/opencode/client.server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-opencode-model-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let rootDir = '';
let originalHome: string | undefined;

function seedStackYaml(): void {
  const state = getState();
  mkdirSync(state.configDir, { recursive: true });
  const spec = {
    version: 2,
    capabilities: {
      llm: 'openai/gpt-4o',
      embeddings: { provider: 'openai', model: 'text-embedding-3-small', dims: 1536 },
      memory: { userId: 'default_user' },
    },
    addons: {},
  };
  writeFileSync(join(state.configDir, 'stack.yaml'), yamlStringify(spec));
}

function makeEvent(method: string, body?: unknown, token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    request: new Request('http://localhost/admin/opencode/model', {
      method,
      headers: {
        'content-type': 'application/json',
        'x-admin-token': token,
        'x-request-id': 'req-model',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  rootDir = makeTempDir();
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
  seedStackYaml();
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('/admin/opencode/model route', () => {
  test('requires admin token', async () => {
    const res = await GET(makeEvent('GET', undefined, 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('GET returns 503 when OpenCode is unreachable', async () => {
    vi.mocked(getOpenCodeConfig).mockResolvedValueOnce(null);

    const res = await GET(makeEvent('GET'));
    expect(res.status).toBe(503);
  });

  test('POST rejects an empty model', async () => {
    const res = await POST(makeEvent('POST', { model: '   ' }));
    expect(res.status).toBe(400);
  });

  test('POST persists the model and propagates OpenCode 4xx errors', async () => {
    vi.mocked(proxyToOpenCode).mockResolvedValueOnce({
      ok: false,
      status: 400,
      code: 'opencode_error',
      message: 'Invalid model',
    });

    const res = await POST(makeEvent('POST', { model: 'bad-model' }));
    expect(res.status).toBe(400);

    const body = await res.json() as { message: string };
    expect(body.message).toBe('Invalid model');
  });

  test('POST degrades gracefully when OpenCode is unavailable', async () => {
    vi.mocked(proxyToOpenCode).mockResolvedValueOnce({
      ok: false,
      status: 503,
      code: 'opencode_unavailable',
      message: 'OpenCode is not reachable',
    });

    const res = await POST(makeEvent('POST', { model: 'gpt-4.1-mini' }));
    expect(res.status).toBe(200);

    const body = await res.json() as { ok: boolean; restartRequired: boolean; liveApplied: boolean };
    expect(body.ok).toBe(true);
    expect(body.liveApplied).toBe(false);
    expect(body.restartRequired).toBe(true);
  });
});
