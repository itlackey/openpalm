import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { getState, resetState } from '$lib/server/state.js';
import { POST } from './+server.js';

vi.mock('$lib/server/memory-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/memory-config.js')>();
  return {
    ...actual,
    fetchProviderModels: vi.fn(),
  };
});

import { fetchProviderModels } from '$lib/server/memory-config.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let rootDir = '';
let originalConfigHome: string | undefined;
let originalStateHome: string | undefined;
let originalDataHome: string | undefined;

beforeEach(() => {
  rootDir = makeTempDir();
  originalConfigHome = process.env.OPENPALM_CONFIG_HOME;
  originalStateHome = process.env.OPENPALM_STATE_HOME;
  originalDataHome = process.env.OPENPALM_DATA_HOME;
  process.env.OPENPALM_CONFIG_HOME = join(rootDir, 'config');
  process.env.OPENPALM_STATE_HOME = join(rootDir, 'state');
  process.env.OPENPALM_DATA_HOME = join(rootDir, 'data');
  resetState('admin-token');

  const state = getState();
  mkdirSync(state.configDir, { recursive: true });
  writeFileSync(
    join(state.configDir, 'secrets.env'),
    'OPENAI_API_KEY=sk-test\n'
  );
});

afterEach(() => {
  process.env.OPENPALM_CONFIG_HOME = originalConfigHome;
  process.env.OPENPALM_STATE_HOME = originalStateHome;
  process.env.OPENPALM_DATA_HOME = originalDataHome;
  rmSync(rootDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function makeEvent(body?: unknown, token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/admin/connections/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': token,
        'x-request-id': 'req-test',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

describe('POST /admin/connections/test', () => {
  test('returns 401 when no valid token provided', async () => {
    const res = await POST(makeEvent({ baseUrl: 'https://api.openai.com/v1' }, 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns 400 when baseUrl is missing', async () => {
    const res = await POST(makeEvent({ apiKey: 'sk-test' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_input');
  });

  test('returns 400 when baseUrl is empty string', async () => {
    const res = await POST(makeEvent({ baseUrl: '  ' }));
    expect(res.status).toBe(400);
  });

  test('returns ok:true with models when fetchProviderModels succeeds', async () => {
    vi.mocked(fetchProviderModels).mockResolvedValueOnce({
      models: ['gpt-4', 'gpt-4o'],
      status: 'ok',
      reason: 'none',
    });

    const res = await POST(makeEvent({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.models).toEqual(['gpt-4', 'gpt-4o']);
    expect(body.errorCode).toBeUndefined();
  });

  test('returns ok:false with errorCode:unauthorized when provider returns 401', async () => {
    vi.mocked(fetchProviderModels).mockResolvedValueOnce({
      models: [],
      status: 'recoverable_error',
      reason: 'provider_http',
      error: 'Provider API returned 401',
    });

    const res = await POST(makeEvent({ baseUrl: 'https://api.openai.com/v1', apiKey: 'bad-key' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errorCode).toBe('unauthorized');
  });

  test('returns ok:false with errorCode:timeout when fetchProviderModels times out', async () => {
    vi.mocked(fetchProviderModels).mockResolvedValueOnce({
      models: [],
      status: 'recoverable_error',
      reason: 'timeout',
      error: 'Request timed out after 5s',
    });

    const res = await POST(makeEvent({ baseUrl: 'https://unreachable.example.com/v1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errorCode).toBe('timeout');
  });

  test('derives ollama provider for URLs containing :11434', async () => {
    vi.mocked(fetchProviderModels).mockResolvedValueOnce({
      models: ['llama3.2'],
      status: 'ok',
      reason: 'none',
    });

    const res = await POST(makeEvent({ baseUrl: 'http://localhost:11434', kind: 'local' }));
    expect(res.status).toBe(200);
    expect(vi.mocked(fetchProviderModels)).toHaveBeenCalledWith(
      'ollama',
      expect.any(String),
      'http://localhost:11434',
      expect.any(String)
    );
  });
});
