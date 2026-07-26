/**
 * /voice/* pass-through: session-authed, availability-gated (enabled addon in
 * readable stack state — NOT admin capability; a served non-admin host
 * process must still pass voice through), allowlisted to the container's
 * OpenAI surface, and transparent (method/path/query/body/content-type
 * forwarded 1:1).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState, trackDir, cleanupTempDirs } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { GET, POST } from './+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-voiceproxy-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makeEvent(
  path: string,
  init: { method?: string; body?: BodyInit; contentType?: string; token?: string; search?: string } = {}
): Parameters<typeof POST>[0] {
  const url = new URL(`http://localhost/voice/${path}${init.search ?? ''}`);
  const headers: Record<string, string> = {
    cookie: `op_session=${init.token ?? 'admin-token'}`,
    'x-request-id': 'req-voice-proxy',
  };
  if (init.contentType) headers['content-type'] = init.contentType;
  return {
    url,
    params: { path },
    request: new Request(url, { method: init.method ?? 'GET', headers, body: init.body }),
  } as unknown as Parameters<typeof POST>[0];
}

function enableVoiceAddon(homeDir: string): void {
  const envDir = join(homeDir, 'state');
  mkdirSync(envDir, { recursive: true });
  writeFileSync(join(envDir, 'stack.env'), 'OP_ENABLED_ADDONS=voice\n');
}

const originalFetch = globalThis.fetch;
let originalHome: string | undefined;

beforeEach(() => {
  process.env.OP_ENABLE_ADMIN = '1';
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = makeTempDir();
  resetState('admin-token');
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  delete process.env.OP_UI_NO_LOCAL_VOICE;
  // Assigning undefined coerces to the string "undefined" and leaks OP_HOME to
  // later tests in the worker — restore by deleting when it started unset.
  if (originalHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = originalHome;
  globalThis.fetch = originalFetch;
  cleanupTempDirs();
  rmSync(getState().homeDir, { recursive: true, force: true });
});

describe('/voice pass-through', () => {
  test('requires a session', async () => {
    enableVoiceAddon(getState().homeDir);
    const res = await GET(makeEvent('v1/models', { token: 'bad-token' }));
    expect(res.status).toBe(401);
  });

  test('503 voice_unavailable when the addon is not enabled', async () => {
    const res = await GET(makeEvent('v1/models'));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'voice_unavailable' });
  });

  test('passes through in a non-admin-capable process (voice is not a host:* privilege)', async () => {
    enableVoiceAddon(getState().homeDir);
    delete process.env.OP_ENABLE_ADMIN;
    const fetchMock = vi.fn(async () =>
      new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await GET(makeEvent('v1/models'));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });

  test('still requires a session in a non-admin process (auth, not admin, is the boundary)', async () => {
    enableVoiceAddon(getState().homeDir);
    delete process.env.OP_ENABLE_ADMIN;
    const res = await GET(makeEvent('v1/models', { token: 'bad-token' }));
    expect(res.status).toBe(401);
  });

  test('503 voice_unavailable when the process cannot serve local voice (OP_UI_NO_LOCAL_VOICE=1)', async () => {
    enableVoiceAddon(getState().homeDir);
    process.env.OP_UI_NO_LOCAL_VOICE = '1';
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await GET(makeEvent('v1/models'));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'voice_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('HEAD carries no upstream body (SvelteKit routes HEAD through GET; undici rejects a body)', async () => {
    enableVoiceAddon(getState().homeDir);
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await GET(makeEvent('v1/models', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  test('does not forward upstream content-length (undici decompresses transparently)', async () => {
    enableVoiceAddon(getState().homeDir);
    globalThis.fetch = vi.fn(async () =>
      new Response('{"data":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '999' },
      })
    ) as unknown as typeof fetch;
    const res = await GET(makeEvent('v1/models'));
    expect(res.headers.get('content-length')).toBeNull();
  });

  test('404 for a path outside the OpenAI surface', async () => {
    enableVoiceAddon(getState().homeDir);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await GET(makeEvent('admin/secrets'));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('forwards POST body + content-type to the loopback container and streams the reply', async () => {
    enableVoiceAddon(getState().homeDir);
    const fetchMock = vi.fn(async () =>
      new Response('audio-bytes', { status: 200, headers: { 'content-type': 'audio/wav' } })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(
      makeEvent('v1/audio/speech', {
        method: 'POST',
        body: JSON.stringify({ model: 'kokoro', input: 'hi', response_format: 'wav' }),
        contentType: 'application/json',
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(await res.text()).toBe('audio-bytes');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { body: ArrayBuffer }];
    expect(url).toBe('http://127.0.0.1:8880/v1/audio/speech');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(new TextDecoder().decode(init.body)).toContain('"input":"hi"');
  });

  test('honors OP_VOICE_PORT_HOST and forwards the query string', async () => {
    enableVoiceAddon(getState().homeDir);
    process.env.OP_VOICE_PORT_HOST = '9123';
    try {
      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const res = await GET(makeEvent('v1/models', { search: '?x=1' }));
      expect(res.status).toBe(200);
      const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
      expect(String(calls[0]?.[0])).toBe('http://127.0.0.1:9123/v1/models?x=1');
    } finally {
      delete process.env.OP_VOICE_PORT_HOST;
    }
  });

  test('502 voice_unreachable when the container is down', async () => {
    enableVoiceAddon(getState().homeDir);
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const res = await GET(makeEvent('health'));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'voice_unreachable' });
  });
});
