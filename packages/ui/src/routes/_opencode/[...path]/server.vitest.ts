/**
 * /_opencode/* — the same-origin OpenCode WEB UI proxy.
 *
 * The contract that makes `/advanced` work behind any ordinary reverse proxy:
 * the session is the credential, the upstream Basic credential is attached
 * server-side, the HTML document is taught it is not at the origin root, and
 * everything that is not HTML streams through untouched.
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
  getAssistantOpencodeTarget: () => target.value,
}));

import { GET, POST } from './+server.js';
import { WORKSPACE_PREFIX, WORKSPACE_SHIM } from '$lib/server/opencode-workspace.js';
import { _clearSessions, _seedSession } from '$lib/server/session-store.js';

const ENV_KEY = 'OP_UI_LOGIN_PASSWORD';
const SESSION = 'test-session-token';
const OPENCODE_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-theirs'; connect-src * data:";
let savedEnv: string | undefined;
let lastRequest: { url: string; init: RequestInit } | null = null;

function stubFetch(response: Response): void {
  lastRequest = null;
  vi.stubGlobal('fetch', (async (url: string, init: RequestInit) => {
    lastRequest = { url: String(url), init };
    return response;
  }) as unknown as typeof globalThis.fetch);
}

function htmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html', ...headers },
  });
}

function makeEvent(
  path: string,
  init: { method?: string; body?: string; search?: string; withSession?: boolean } = {},
): Parameters<typeof GET>[0] {
  const url = new URL(`http://openpalm.local:3800${WORKSPACE_PREFIX}/${path}${init.search ?? ''}`);
  const headers: Record<string, string> = { 'x-request-id': 'req-ws' };
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

describe('/_opencode/* — auth', () => {
  test('rejects a request with no session', async () => {
    stubFetch(htmlResponse('<html><head></head></html>'));
    const res = await GET(makeEvent('', { withSession: false }));
    expect(res.status).toBe(401);
    // Fail closed: nothing reached OpenCode.
    expect(lastRequest).toBeNull();
  });

  test('attaches the upstream Basic credential server-side, never the cookie', async () => {
    target.value = { ...target.value, password: 'opencode-secret' };
    stubFetch(htmlResponse('<html><head></head></html>'));
    await GET(makeEvent(''));
    const sent = new Headers(lastRequest?.init.headers as HeadersInit);
    expect(sent.get('authorization')).toBe(
      `Basic ${Buffer.from('opencode:opencode-secret').toString('base64')}`,
    );
    expect(sent.get('cookie')).toBeNull();
  });
});

describe('/_opencode/* — upstream mapping', () => {
  test('forwards the path after the prefix, with the query string', async () => {
    stubFetch(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    await GET(makeEvent('api/session', { search: '?directory=%2Fwork' }));
    expect(lastRequest?.url).toBe('http://localhost:4096/api/session?directory=%2Fwork');
  });

  test('the workspace root maps to the upstream root', async () => {
    stubFetch(htmlResponse('<html><head></head></html>'));
    await GET(makeEvent(''));
    expect(lastRequest?.url).toBe('http://localhost:4096/');
  });

  test('reports an unreachable assistant as 502, not a broken frame', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch);
    const res = await GET(makeEvent(''));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('assistant_unreachable');
  });
});

describe('/_opencode/* — document rewriting', () => {
  test('injects the client shim into the document head', async () => {
    stubFetch(htmlResponse('<html><head><title>OpenCode</title></head><body></body></html>'));
    const res = await GET(makeEvent(''));
    const body = await res.text();
    expect(body).toContain(WORKSPACE_SHIM);
    // Before OpenCode's own head content, so the retargeting is in place
    // before anything the document itself loads.
    expect(body.indexOf(WORKSPACE_SHIM)).toBeLessThan(body.indexOf('<title>'));
  });

  test('adds the shim hash to the upstream script-src so the browser runs it', async () => {
    stubFetch(
      htmlResponse('<html><head></head></html>', { 'content-security-policy': OPENCODE_CSP }),
    );
    const res = await GET(makeEvent(''));
    const policy = res.headers.get('content-security-policy') ?? '';
    // The upstream's own sources survive; ours is added, not substituted.
    expect(policy).toContain("'wasm-unsafe-eval'");
    expect(policy).toContain("'sha256-theirs'");
    expect(policy).toMatch(/script-src[^;]*'sha256-[A-Za-z0-9+/=]{40,}'/);
  });

  test('a deep link is rewritten too — OpenCode serves its shell for any path', async () => {
    stubFetch(htmlResponse('<html><head></head></html>'));
    const res = await GET(makeEvent('L3dvcms/session/ses_123'));
    expect(lastRequest?.url).toBe('http://localhost:4096/L3dvcms/session/ses_123');
    expect(await res.text()).toContain(WORKSPACE_SHIM);
  });

  test('leaves non-HTML responses byte-identical', async () => {
    const payload = JSON.stringify({ sessions: [] });
    stubFetch(
      new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const res = await GET(makeEvent('api/session'));
    expect(await res.text()).toBe(payload);
  });

  test('does not touch a JSON body that happens to mention the shim', async () => {
    stubFetch(
      new Response('{"note":"<head>"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await GET(makeEvent('api/session'));
    expect(await res.text()).toBe('{"note":"<head>"}');
  });
});

describe('/_opencode/* — pass-through hygiene', () => {
  test('drops content-length and content-encoding so streams are not truncated', async () => {
    stubFetch(
      new Response('data: {}\n\n', {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'content-length': '4',
          'content-encoding': 'gzip',
        },
      }),
    );
    const res = await GET(makeEvent('global/event'));
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  test('does not leak an upstream Set-Cookie into this app cookie scope', async () => {
    stubFetch(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'oc=1' },
      }),
    );
    const res = await GET(makeEvent('api/session'));
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('forwards a request body on non-GET methods', async () => {
    stubFetch(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    await POST(makeEvent('api/session', { method: 'POST', body: '{"title":"x"}' }));
    expect(new TextDecoder().decode(lastRequest?.init.body as ArrayBuffer)).toBe('{"title":"x"}');
  });
});
