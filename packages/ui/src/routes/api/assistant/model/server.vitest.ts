import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';
import { GET, POST } from './+server.js';

const getConfig = vi.fn();

vi.mock('$lib/server/helpers.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/helpers.js')>('$lib/server/helpers.js');
  return {
    ...actual,
    getOpenCodeClient: () => ({ getConfig }),
  };
});

vi.mock('$lib/server/opencode/config.js', () => ({
  setMainModel: vi.fn(async () => undefined),
  unsetMainModel: vi.fn(async () => undefined),
}));

import { setMainModel, unsetMainModel } from '$lib/server/opencode/config.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-opencode-model-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(method: string, body?: unknown, token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    request: new Request('http://localhost/api/assistant/model', {
      method,
      headers: {
        'content-type': 'application/json',
        cookie: `op_session=${token}`,
        'x-request-id': 'req-model',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // assistant-settings is a base capability, present in every process.
  process.env.OP_ENABLE_ADMIN = '1';
  rootDir = makeTempDir();
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('/api/assistant/model route', () => {
  test('requires admin token', async () => {
    const res = await GET(makeEvent('GET', undefined, 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('GET returns 503 when OpenCode is unreachable', async () => {
    getConfig.mockResolvedValueOnce(null);
    const res = await GET(makeEvent('GET'));
    expect(res.status).toBe(503);
  });

  test('GET returns model + small_model', async () => {
    getConfig.mockResolvedValueOnce({ model: 'openai/gpt-4o', small_model: 'openai/gpt-4o-mini' });
    const res = await GET(makeEvent('GET'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string; small_model: string };
    expect(body.model).toBe('openai/gpt-4o');
    expect(body.small_model).toBe('openai/gpt-4o-mini');
  });

  test('POST without model or small_model is rejected', async () => {
    const res = await POST(makeEvent('POST', {}));
    expect(res.status).toBe(400);
  });

  test('POST rejects malformed model (no provider prefix)', async () => {
    const res = await POST(makeEvent('POST', { model: 'gpt-4o' }));
    expect(res.status).toBe(400);
  });

  test('POST writes model via setMainModel', async () => {
    const res = await POST(makeEvent('POST', { model: 'openai/gpt-4o' }));
    expect(res.status).toBe(200);
    expect(setMainModel).toHaveBeenCalledWith('openai', 'gpt-4o', 'model');
  });

  test('POST writes both model and small_model', async () => {
    const res = await POST(makeEvent('POST', {
      model: 'openai/gpt-4o',
      small_model: 'openai/gpt-4o-mini',
    }));
    expect(res.status).toBe(200);
    expect(setMainModel).toHaveBeenCalledWith('openai', 'gpt-4o', 'model');
    expect(setMainModel).toHaveBeenCalledWith('openai', 'gpt-4o-mini', 'small_model');
  });

  test('POST with empty model unsets the field', async () => {
    const res = await POST(makeEvent('POST', { model: '' }));
    expect(res.status).toBe(200);
    expect(unsetMainModel).toHaveBeenCalledWith('model');
  });

  test('POST with null small_model unsets it', async () => {
    const res = await POST(makeEvent('POST', { small_model: null }));
    expect(res.status).toBe(200);
    expect(unsetMainModel).toHaveBeenCalledWith('small_model');
  });

  test('POST with empty string small_model calls unsetMainModel("small_model")', async () => {
    const res = await POST(makeEvent('POST', { small_model: '' }));
    expect(res.status).toBe(200);
    expect(unsetMainModel).toHaveBeenCalledWith('small_model');
    expect(setMainModel).not.toHaveBeenCalled();
  });

  test('POST returns 500 with "Failed to persist model selection" when setMainModel throws', async () => {
    vi.mocked(setMainModel).mockRejectedValueOnce(new Error('disk write failed'));

    const res = await POST(makeEvent('POST', { model: 'openai/gpt-4o' }));

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('internal_error');
    expect(body.message).toBe('Failed to persist model selection');
  });
});
