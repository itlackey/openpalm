/**
 * /oc/* — the same-origin OpenCode pass-through.
 *
 * What matters here is the contract that lets the browser stop talking to
 * OpenCode directly: the session is the credential, the upstream credential is
 * attached server-side and never reaches the browser, and streamed bodies pass
 * through without the header rewrites that would truncate them.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const target = vi.hoisted(() => ({
  value: {
    id: 'default',
    label: 'Local Assistant',
    url: 'http://localhost:4096',
    username: 'opencode' as string | undefined,
    password: undefined as string | undefined,
    isDefault: true,
  },
}));

vi.mock('$lib/server/opencode-target.js', () => ({
  getHostOpencodeTarget: () => target.value,
}));

import { GET, POST } from './+server.js';
import { _clearSessions, _seedSession } from '$lib/server/session-store.js';

const ENV_KEY = 'OP_UI_LOGIN_PASSWORD';
const SESSION = 'test-session-token';
let savedEnv: string | undefined;
let lastRequest: { url: string; init: RequestInit } | null = null;

function stubFetch(response: Response): void {
  lastRequest = null;
  vi.stubGlobal('fetch', (async (url: string, init: RequestInit) => {
    lastRequest = { url: String(url), init };
    return response;
  }) as unknown as typeof globalThis.fetch);
}

function makeEvent(
  path: string,
  init: { method?: string; body?: string; search?: string; withSession?: boolean } = {},
): Parameters<typeof GET>[0] {
  const url = new URL(`http://openpalm.local:3800/oc/${path}${init.search ?? ''}`);
  const headers: Record<string, string> = { 'x-request-id': 'req-oc' };
  if (init.withSession !== false) headers.cookie = `op_session=${SESSION}`;
  if (init.body) headers['content-type'] = 'application/json';
  return {
    url,
    params: { path },
    request: new Request(url, { method: init.method ?? 'GET', headers, body: init.body }),
    getClientAddress: () => '192.168.1.50',
  } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = 'login-password';
  _clearSessions();
  _seedSession(SESSION);
  target.value = {
    id: 'default',
    label: 'Local Assistant',
    url: 'http://localhost:4096',
    username: 'opencode',
    password: undefined,
    isDefault: true,
  };
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  _clearSessions();
  vi.unstubAllGlobals();
});

describe('/oc/* — auth', () => {
  test('401s without a session — the session IS the credential for the local assistant', async () => {
    stubFetch(new Response('{}', { status: 200 }));
    const res = await GET(makeEvent('session', { withSession: false }));
    expect(res.status).toBe(401);
    expect(lastRequest).toBeNull();
  });

  test('passes through with a valid session', async () => {
    stubFetch(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    const res = await GET(makeEvent('session'));
    expect(res.status).toBe(200);
    expect(lastRequest?.url).toBe('http://localhost:4096/session');
  });
});

describe('/oc/* — upstream credential', () => {
  test('attaches Basic auth server-side when OpenCode requires it', async () => {
    // This is what closes the third LAN failure: the browser used to receive a
    // connection with auth mode "none" and 401 against an auth-enabled
    // OpenCode, leaving the operator to paste the password in by hand.
    target.value = { ...target.value, password: 'opencode-secret' };
    stubFetch(new Response('[]', { status: 200 }));
    await GET(makeEvent('session'));

    const sent = new Headers(lastRequest?.init.headers as HeadersInit);
    const expected = `Basic ${Buffer.from('opencode:opencode-secret').toString('base64')}`;
    expect(sent.get('authorization')).toBe(expected);
  });

  test('sends no Authorization when OpenCode has no password', async () => {
    stubFetch(new Response('[]', { status: 200 }));
    await GET(makeEvent('session'));
    expect(new Headers(lastRequest?.init.headers as HeadersInit).get('authorization')).toBeNull();
  });

  test("never forwards the browser's session cookie upstream", async () => {
    stubFetch(new Response('[]', { status: 200 }));
    await GET(makeEvent('session'));
    expect(new Headers(lastRequest?.init.headers as HeadersInit).get('cookie')).toBeNull();
  });
});

describe('/oc/* — transparency', () => {
  test('preserves path and query verbatim', async () => {
    stubFetch(new Response('{}', { status: 200 }));
    await GET(makeEvent('session/abc/message', { search: '?limit=10' }));
    expect(lastRequest?.url).toBe('http://localhost:4096/session/abc/message?limit=10');
  });

  test('forwards a POST body', async () => {
    stubFetch(new Response('{}', { status: 200 }));
    await POST(makeEvent('session', { method: 'POST', body: '{"hello":"world"}' }));
    expect(lastRequest?.init.method).toBe('POST');
    expect(new TextDecoder().decode(lastRequest?.init.body as ArrayBuffer)).toBe(
      '{"hello":"world"}',
    );
  });

  test('propagates the upstream status rather than masking it', async () => {
    stubFetch(new Response('nope', { status: 404 }));
    expect((await GET(makeEvent('missing'))).status).toBe(404);
  });

  test('drops content-length and content-encoding, which would truncate a decompressed body', async () => {
    // node's fetch transparently decompresses while still exposing the
    // ORIGINAL compressed content-length; forwarding it truncates the stream
    // the browser actually receives.
    stubFetch(
      new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '9999', 'content-encoding': 'gzip' },
      }),
    );
    const res = await GET(makeEvent('session'));
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  test('preserves the SSE content-type so /event streams as a stream', async () => {
    stubFetch(new Response('data: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const res = await GET(makeEvent('event'));
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });

  test('502s when the assistant is unreachable, rather than surfacing a raw throw', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new TypeError('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch);
    const res = await GET(makeEvent('session'));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'assistant_unreachable' });
  });
});
