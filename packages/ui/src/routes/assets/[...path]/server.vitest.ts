/**
 * /assets/* — OpenCode's static bundle at this origin's root.
 *
 * This route exists because the SPA reaches for these files through channels
 * no injected script can intercept, so what matters is that the mapping is
 * exact and that it never becomes a general-purpose tunnel into OpenCode.
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

import * as route from './+server.js';
import { _clearSessions, _seedSession } from '$lib/server/session-store.js';

const ENV_KEY = 'OP_UI_LOGIN_PASSWORD';
const SESSION = 'test-session-token';
let savedEnv: string | undefined;
let lastRequest: { url: string } | null = null;

function stubFetch(response: Response): void {
  lastRequest = null;
  vi.stubGlobal('fetch', (async (url: string) => {
    lastRequest = { url: String(url) };
    return response;
  }) as unknown as typeof globalThis.fetch);
}

function makeEvent(
  path: string,
  init: { withSession?: boolean } = {},
): Parameters<typeof route.GET>[0] {
  const url = new URL(`http://openpalm.local:3800/assets/${path}`);
  const headers: Record<string, string> = { 'x-request-id': 'req-assets' };
  if (init.withSession !== false) headers.cookie = `op_session=${SESSION}`;
  return {
    url,
    params: { path },
    request: new Request(url, { headers }),
    getClientAddress: () => '192.168.1.50',
  } as unknown as Parameters<typeof route.GET>[0];
}

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = 'login-password';
  _clearSessions();
  _seedSession(SESSION);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  _clearSessions();
  vi.unstubAllGlobals();
});

describe('/assets/*', () => {
  test('maps 1:1 onto the upstream asset path', async () => {
    stubFetch(
      new Response('body{}', { status: 200, headers: { 'content-type': 'text/css' } }),
    );
    const res = await route.GET(makeEvent('index-DK7wAe8r.css'));
    expect(lastRequest?.url).toBe('http://localhost:4096/assets/index-DK7wAe8r.css');
    expect(await res.text()).toBe('body{}');
  });

  test('serves the nested paths Vite emits', async () => {
    stubFetch(new Response('', { status: 200 }));
    await route.GET(makeEvent('fonts/Inter.ttf'));
    expect(lastRequest?.url).toBe('http://localhost:4096/assets/fonts/Inter.ttf');
  });

  test('requires the session, like every other route into the assistant', async () => {
    stubFetch(new Response('', { status: 200 }));
    const res = await route.GET(makeEvent('index.js', { withSession: false }));
    expect(res.status).toBe(401);
    expect(lastRequest).toBeNull();
  });

  test('is GET-only — it is not a second API tunnel', () => {
    expect(route.GET).toBeTypeOf('function');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect(route, method).not.toHaveProperty(method);
    }
  });

  test('propagates an upstream 404 rather than inventing one', async () => {
    stubFetch(new Response('not found', { status: 404 }));
    const res = await route.GET(makeEvent('stale-chunk.js'));
    expect(res.status).toBe(404);
  });
});
