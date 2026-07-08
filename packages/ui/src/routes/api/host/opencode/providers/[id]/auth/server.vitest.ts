import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';
import { GET, POST, DELETE } from './+server.js';

const setProviderApiKey = vi.fn();
const startProviderOAuth = vi.fn();
const completeProviderOAuth = vi.fn();
const proxy = vi.fn();

vi.mock('$lib/server/helpers.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/helpers.js')>('$lib/server/helpers.js');
  return {
    ...actual,
    getOpenCodeClient: () => ({
      setProviderApiKey,
      startProviderOAuth,
      completeProviderOAuth,
      proxy,
    }),
  };
});

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-opencode-auth-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(
  method: 'GET' | 'POST' | 'DELETE',
  options?: {
    token?: string;
    body?: unknown;
    search?: string;
    providerId?: string;
  },
): Parameters<typeof GET>[0] {
  const providerId = options?.providerId ?? 'openai';
  const url = new URL(`http://localhost/api/host/opencode/providers/${providerId}/auth`);
  if (options?.search) {
    url.search = options.search;
  }

  return {
    params: { id: providerId },
    request: new Request(url, {
      method,
      headers: {
        'content-type': 'application/json',
        cookie: `op_session=${options?.token ?? 'admin-token'}`,
        'x-request-id': 'req-auth',
      },
      body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    url,
  } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_UI_HOST_MODE = 'host-ui';
  vi.useRealTimers();
  rootDir = makeTempDir();
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
});

afterEach(() => {
  delete process.env.OP_UI_HOST_MODE;
  vi.useRealTimers();
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('/api/host/opencode/providers/[id]/auth route', () => {
  // ── Auth ────────────────────────────────────────────────────────────
  test('requires admin token', async () => {
    const res = await POST(makeEvent('POST', {
      token: 'bad-token',
      body: { mode: 'api_key', apiKey: 'sk-test' },
    }));
    expect(res.status).toBe(401);
  });

  // ── API key POST mode ──────────────────────────────────────────────
  test('sends API key to OpenCode', async () => {
    setProviderApiKey.mockResolvedValueOnce({ ok: true, data: true });

    const res = await POST(makeEvent('POST', {
      providerId: 'groq',
      body: { mode: 'api_key', apiKey: 'gsk-test-key' },
    }));

    expect(res.status).toBe(200);
    expect(setProviderApiKey).toHaveBeenCalledWith('groq', 'gsk-test-key');
  });

  test('never echoes secrets in response', async () => {
    setProviderApiKey.mockResolvedValueOnce({ ok: true, data: true });

    const res = await POST(makeEvent('POST', {
      body: { mode: 'api_key', apiKey: 'sk-test-secret' },
    }));

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('sk-test-secret');
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

  test('api_key POST returns ok:true and mode in response', async () => {
    setProviderApiKey.mockResolvedValueOnce({ ok: true, data: true });

    const res = await POST(makeEvent('POST', {
      body: { mode: 'api_key', apiKey: 'sk-valid' },
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; mode: string };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('api_key');
  });

  test('returns 5xx when OpenCode rejects — auth.json is the only persistence path', async () => {
    setProviderApiKey.mockResolvedValueOnce({ ok: false, status: 503, code: 'opencode_unreachable', message: 'OpenCode down' });

    const res = await POST(makeEvent('POST', {
      body: { mode: 'api_key', apiKey: 'sk-still-saves' },
    }));

    expect(res.status).toBe(503);
  });

  test('does NOT write stack secrets — credentials live in OpenCode auth.json only', async () => {
    setProviderApiKey.mockResolvedValueOnce({ ok: true, data: true });

    const res = await POST(makeEvent('POST', {
      providerId: 'groq',
      body: { mode: 'api_key', apiKey: 'gsk-test-key' },
    }));

    expect(res.status).toBe(200);
    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { getState } = await import('$lib/server/state.js');
    const stackEnvPath = join(getState().stackDir, 'stack.env');
    if (existsSync(stackEnvPath)) {
      expect(readFileSync(stackEnvPath, 'utf-8')).not.toContain('GROQ_API_KEY=gsk-test-key');
    }
    expect(existsSync(join(getState().stackDir, 'secrets', 'groq_api_key'))).toBe(false);
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
    startProviderOAuth.mockResolvedValueOnce({
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
    startProviderOAuth.mockResolvedValueOnce({
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
    expect(startProviderOAuth).toHaveBeenCalledWith('openai', 0);
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
    startProviderOAuth.mockResolvedValueOnce({
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
    startProviderOAuth.mockResolvedValueOnce({
      ok: true,
      data: {
        url: 'https://example.com/auth',
        method: 'auto',
        instructions: 'Sign in',
      },
    });
    completeProviderOAuth.mockResolvedValueOnce({
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
    startProviderOAuth.mockResolvedValueOnce({
      ok: true,
      data: { url: 'https://example.com/auth', method: 'auto', instructions: 'Sign in' },
    });
    completeProviderOAuth.mockResolvedValueOnce({
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
    startProviderOAuth.mockResolvedValueOnce({
      ok: true,
      data: {
        url: 'https://example.com/auth',
        method: 'auto',
        instructions: 'Sign in',
      },
    });
    completeProviderOAuth.mockResolvedValueOnce({
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
    startProviderOAuth.mockResolvedValueOnce({
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
    startProviderOAuth.mockResolvedValueOnce({
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

  // ── DELETE handler ─────────────────────────────────────────────────
  test('DELETE rejects unauthenticated request', async () => {
    const res = await DELETE(makeEvent('DELETE', { token: 'bad-token', providerId: 'openai' }));
    expect(res.status).toBe(401);
  });

  test('DELETE rejects invalid provider ID', async () => {
    const res = await DELETE(makeEvent('DELETE', { providerId: 'bad provider!' }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('bad_request');
  });

  test('DELETE success returns { ok: true } and calls proxy with DELETE', async () => {
    proxy.mockResolvedValueOnce({ ok: true, data: null });

    const res = await DELETE(makeEvent('DELETE', { providerId: 'groq' }));

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(proxy).toHaveBeenCalledWith('/auth/groq', { method: 'DELETE' });
  });

  test('DELETE surfaces 4xx from OpenCode', async () => {
    proxy.mockResolvedValueOnce({
      ok: false,
      status: 404,
      code: 'opencode_error',
      message: 'Provider not found',
    });

    const res = await DELETE(makeEvent('DELETE', { providerId: 'nonexistent' }));

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('opencode_error');
  });

  // Phase 6 removed OpenPalm-side appendAudit. OpenCode logs every
  // /auth DELETE natively (D6a in docs/technical/auth-and-proxy-refactor-plan.md),
  // so this contract test now just verifies the DELETE succeeds.
  test('DELETE succeeds for a valid provider', async () => {
    proxy.mockResolvedValueOnce({ ok: true, data: null });

    const res = await DELETE(makeEvent('DELETE', { providerId: 'openai' }));

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
