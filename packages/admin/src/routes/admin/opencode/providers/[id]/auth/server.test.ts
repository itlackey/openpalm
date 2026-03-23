import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { getState, resetState } from '$lib/server/state.js';
import { GET, POST } from './+server.js';

vi.mock('$lib/opencode/client.server.js', () => ({
  setProviderApiKey: vi.fn(),
  startProviderOAuth: vi.fn(),
  completeProviderOAuth: vi.fn(),
}));

import {
  setProviderApiKey,
  startProviderOAuth,
  completeProviderOAuth,
} from '$lib/opencode/client.server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-opencode-auth-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(
  method: 'GET' | 'POST',
  options?: {
    token?: string;
    body?: unknown;
    search?: string;
    providerId?: string;
  },
): Parameters<typeof GET>[0] {
  const providerId = options?.providerId ?? 'openai';
  const url = new URL(`http://localhost/admin/opencode/providers/${providerId}/auth`);
  if (options?.search) {
    url.search = options.search;
  }

  return {
    params: { id: providerId },
    request: new Request(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-admin-token': options?.token ?? 'admin-token',
        'x-request-id': 'req-auth',
      },
      body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    url,
  } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.useRealTimers();
  rootDir = makeTempDir();
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
});

afterEach(() => {
  vi.useRealTimers();
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('/admin/opencode/providers/[id]/auth route', () => {
  test('requires admin token', async () => {
    const res = await POST(makeEvent('POST', {
      token: 'bad-token',
      body: { mode: 'api_key', apiKey: 'sk-test' },
    }));
    expect(res.status).toBe(401);
  });

  test('accepts unknown providers — skips user.env, writes to OpenCode only', async () => {
    vi.mocked(setProviderApiKey).mockResolvedValueOnce({ ok: true, data: true });

    const res = await POST(makeEvent('POST', {
      providerId: 'custom-provider',
      body: { mode: 'api_key', apiKey: 'sk-test' },
    }));

    expect(res.status).toBe(200);
    expect(vi.mocked(setProviderApiKey)).toHaveBeenCalledWith('custom-provider', 'sk-test');
  });

  test('validates API keys before writing and never echoes secrets', async () => {
    vi.mocked(setProviderApiKey).mockResolvedValueOnce({ ok: true, data: true });

    const res = await POST(makeEvent('POST', {
      body: { mode: 'api_key', apiKey: 'sk-test-secret' },
    }));

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('sk-test-secret');

    const userEnvPath = join(getState().vaultDir, 'user', 'user.env');
    expect(readFileSync(userEnvPath, 'utf-8')).toContain('OPENAI_API_KEY=sk-test-secret');
  });

  test('rejects API keys with invalid characters', async () => {
    const res = await POST(makeEvent('POST', {
      body: { mode: 'api_key', apiKey: 'bad\nkey' },
    }));

    expect(res.status).toBe(400);
  });

  test('expires OAuth poll sessions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T07:00:00Z'));
    vi.mocked(startProviderOAuth).mockResolvedValueOnce({
      ok: true,
      data: {
        url: 'https://example.com/auth',
        method: 'auto',
        instructions: 'Sign in',
      },
    });

    const startRes = await POST(makeEvent('POST', {
      body: { mode: 'oauth', methodIndex: 0 },
    }));
    const startBody = await startRes.json() as { pollToken: string };

    vi.setSystemTime(new Date('2026-03-21T07:11:00Z'));
    const pollRes = await GET(makeEvent('GET', {
      search: `?pollToken=${encodeURIComponent(startBody.pollToken)}`,
    }));

    expect(pollRes.status).toBe(404);
  });

  test('returns pending while OAuth completion is still waiting', async () => {
    vi.mocked(startProviderOAuth).mockResolvedValueOnce({
      ok: true,
      data: {
        url: 'https://example.com/auth',
        method: 'auto',
        instructions: 'Sign in',
      },
    });
    vi.mocked(completeProviderOAuth).mockResolvedValueOnce({
      ok: false,
      status: 400,
      code: 'opencode_error',
      message: 'Still pending',
    });

    const startRes = await POST(makeEvent('POST', {
      body: { mode: 'oauth', methodIndex: 0 },
    }));
    const startBody = await startRes.json() as { pollToken: string };

    const pollRes = await GET(makeEvent('GET', {
      search: `?pollToken=${encodeURIComponent(startBody.pollToken)}`,
    }));

    expect(pollRes.status).toBe(200);
    const pollBody = await pollRes.json() as { status: string };
    expect(pollBody.status).toBe('pending');
  });
});
