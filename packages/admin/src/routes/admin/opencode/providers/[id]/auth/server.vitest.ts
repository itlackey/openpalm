import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { getState } from '$lib/server/state.js';
import { resetState } from '$lib/server/test-helpers.js';
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
  // ── Auth ────────────────────────────────────────────────────────────
  test('requires admin token', async () => {
    const res = await POST(makeEvent('POST', {
      token: 'bad-token',
      body: { mode: 'api_key', apiKey: 'sk-test' },
    }));
    expect(res.status).toBe(401);
  });

  // ── API key POST mode ──────────────────────────────────────────────
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

    const stackEnvPath = join(getState().vaultDir, 'stack', 'stack.env');
    expect(readFileSync(stackEnvPath, 'utf-8')).toContain('OPENAI_API_KEY=sk-test-secret');
  });

  test('rejects API keys with invalid characters', async () => {
    const res = await POST(makeEvent('POST', {
      body: { mode: 'api_key', apiKey: 'bad\nkey' },
    }));

    expect(res.status).toBe(400);
  });

  test('rejects missing apiKey in api_key mode', async () => {
    const res = await POST(makeEvent('POST', {
      body: { mode: 'api_key' },
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('bad_request');
  });

  test('rejects empty apiKey in api_key mode', async () => {
    const res = await POST(makeEvent('POST', {
      body: { mode: 'api_key', apiKey: '   ' },
    }));

    expect(res.status).toBe(400);
  });

  test('rejects API key exceeding maximum length', async () => {
    const longKey = 'k'.repeat(513);
    const res = await POST(makeEvent('POST', {
      body: { mode: 'api_key', apiKey: longKey },
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('maximum length');
  });

  test('writes known provider key to vault stack.env', async () => {
    vi.mocked(setProviderApiKey).mockResolvedValueOnce({ ok: true, data: true });

    const res = await POST(makeEvent('POST', {
      providerId: 'anthropic',
      body: { mode: 'api_key', apiKey: 'sk-ant-test-key' },
    }));

    expect(res.status).toBe(200);
    const stackEnvPath = join(getState().vaultDir, 'stack', 'stack.env');
    expect(readFileSync(stackEnvPath, 'utf-8')).toContain('ANTHROPIC_API_KEY=sk-ant-test-key');
  });

  test('api_key POST returns ok:true and mode in response', async () => {
    vi.mocked(setProviderApiKey).mockResolvedValueOnce({ ok: true, data: true });

    const res = await POST(makeEvent('POST', {
      body: { mode: 'api_key', apiKey: 'sk-valid' },
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; mode: string };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('api_key');
  });

  test('continues even if OpenCode setProviderApiKey rejects', async () => {
    vi.mocked(setProviderApiKey).mockRejectedValueOnce(new Error('OpenCode down'));

    const res = await POST(makeEvent('POST', {
      body: { mode: 'api_key', apiKey: 'sk-still-saves' },
    }));

    // Should succeed — OpenCode registration is non-critical
    expect(res.status).toBe(200);
    const stackEnvPath = join(getState().vaultDir, 'stack', 'stack.env');
    expect(readFileSync(stackEnvPath, 'utf-8')).toContain('OPENAI_API_KEY=sk-still-saves');
  });

  // ── Invalid mode ───────────────────────────────────────────────────
  test('rejects unknown mode', async () => {
    const res = await POST(makeEvent('POST', {
      body: { mode: 'unknown' },
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toBe('mode must be api_key or oauth');
  });

  // ── Provider ID validation ─────────────────────────────────────────
  test('rejects invalid provider ID characters', async () => {
    const res = await POST(makeEvent('POST', {
      providerId: 'bad provider!',
      body: { mode: 'api_key', apiKey: 'sk-test' },
    }));

    expect(res.status).toBe(400);
  });

  // ── OAuth POST mode ────────────────────────────────────────────────
  test('oauth POST starts OAuth flow and returns pollToken', async () => {
    vi.mocked(startProviderOAuth).mockResolvedValueOnce({
      ok: true,
      data: {
        url: 'https://accounts.google.com/auth',
        method: 'browser',
        instructions: 'Open the URL to sign in',
      },
    });

    const res = await POST(makeEvent('POST', {
      providerId: 'google',
      body: { mode: 'oauth', methodIndex: 0 },
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      mode: string;
      pollToken: string;
      url: string;
      method: string;
      instructions: string;
    };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('oauth');
    expect(body.pollToken).toBeTruthy();
    expect(body.url).toBe('https://accounts.google.com/auth');
    expect(body.method).toBe('browser');
    expect(body.instructions).toBe('Open the URL to sign in');
  });

  test('oauth POST defaults methodIndex to 0 when omitted', async () => {
    vi.mocked(startProviderOAuth).mockResolvedValueOnce({
      ok: true,
      data: {
        url: 'https://example.com/auth',
        method: 'auto',
        instructions: 'Sign in',
      },
    });

    const res = await POST(makeEvent('POST', {
      body: { mode: 'oauth' },
    }));

    expect(res.status).toBe(200);
    expect(vi.mocked(startProviderOAuth)).toHaveBeenCalledWith('openai', 0);
  });

  test('oauth POST rejects negative methodIndex', async () => {
    const res = await POST(makeEvent('POST', {
      body: { mode: 'oauth', methodIndex: -1 },
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('methodIndex');
  });

  test('oauth POST rejects non-integer methodIndex', async () => {
    const res = await POST(makeEvent('POST', {
      body: { mode: 'oauth', methodIndex: 1.5 },
    }));

    expect(res.status).toBe(400);
  });

  test('oauth POST propagates startProviderOAuth failures', async () => {
    vi.mocked(startProviderOAuth).mockResolvedValueOnce({
      ok: false,
      status: 503,
      code: 'opencode_unavailable',
      message: 'OpenCode is not reachable',
    });

    const res = await POST(makeEvent('POST', {
      body: { mode: 'oauth', methodIndex: 0 },
    }));

    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('opencode_unavailable');
  });

  // ── GET poll session ───────────────────────────────────────────────
  test('GET requires pollToken parameter', async () => {
    const res = await GET(makeEvent('GET'));

    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('pollToken');
  });

  test('GET returns 404 for unknown pollToken', async () => {
    const res = await GET(makeEvent('GET', {
      search: '?pollToken=nonexistent-token',
    }));

    expect(res.status).toBe(404);
  });

  test('GET returns complete when OAuth flow succeeds', async () => {
    vi.mocked(startProviderOAuth).mockResolvedValueOnce({
      ok: true,
      data: {
        url: 'https://example.com/auth',
        method: 'auto',
        instructions: 'Sign in',
      },
    });
    vi.mocked(completeProviderOAuth).mockResolvedValueOnce({
      ok: true,
      data: { token: 'access-token' },
    });

    // Start OAuth to get a pollToken
    const startRes = await POST(makeEvent('POST', {
      body: { mode: 'oauth', methodIndex: 0 },
    }));
    const startBody = await startRes.json() as { pollToken: string };

    // Poll — should complete
    const pollRes = await GET(makeEvent('GET', {
      search: `?pollToken=${encodeURIComponent(startBody.pollToken)}`,
    }));

    expect(pollRes.status).toBe(200);
    const pollBody = await pollRes.json() as { status: string; message: string };
    expect(pollBody.status).toBe('complete');
    expect(pollBody.message).toBe('Authorization successful');
  });

  test('GET removes session after successful completion', async () => {
    vi.mocked(startProviderOAuth).mockResolvedValueOnce({
      ok: true,
      data: { url: 'https://example.com/auth', method: 'auto', instructions: 'Sign in' },
    });
    vi.mocked(completeProviderOAuth).mockResolvedValueOnce({
      ok: true,
      data: { token: 'access-token' },
    });

    const startRes = await POST(makeEvent('POST', { body: { mode: 'oauth' } }));
    const startBody = await startRes.json() as { pollToken: string };

    // First poll — completes
    await GET(makeEvent('GET', {
      search: `?pollToken=${encodeURIComponent(startBody.pollToken)}`,
    }));

    // Second poll — session should be gone
    const secondPoll = await GET(makeEvent('GET', {
      search: `?pollToken=${encodeURIComponent(startBody.pollToken)}`,
    }));
    expect(secondPoll.status).toBe(404);
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

  test('GET rejects provider ID mismatch on poll', async () => {
    vi.mocked(startProviderOAuth).mockResolvedValueOnce({
      ok: true,
      data: { url: 'https://example.com/auth', method: 'auto', instructions: 'Sign in' },
    });

    // Start OAuth for openai
    const startRes = await POST(makeEvent('POST', {
      providerId: 'openai',
      body: { mode: 'oauth' },
    }));
    const startBody = await startRes.json() as { pollToken: string };

    // Poll with a different provider ID
    const pollRes = await GET(makeEvent('GET', {
      providerId: 'anthropic',
      search: `?pollToken=${encodeURIComponent(startBody.pollToken)}`,
    }));

    expect(pollRes.status).toBe(400);
    const body = await pollRes.json() as { message: string };
    expect(body.message).toContain('does not match');
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

  test('GET requires admin token', async () => {
    const res = await GET(makeEvent('GET', {
      token: 'bad-token',
      search: '?pollToken=some-token',
    }));
    expect(res.status).toBe(401);
  });
});
