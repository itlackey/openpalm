/**
 * Integration tests for hooks.server.ts.
 *
 * Key scenario: sliding renewal must set a NEW op_session cookie with a
 * fresh-TTL token, not recycle the old token value. With stateless HMAC tokens
 * the old token has an immutable expiry — only a new token extends the window.
 */
import { beforeEach, afterEach, describe, test, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { resetState } from '$lib/server/test-helpers.js';
import { createSession } from '$lib/server/session-store.js';
import { SESSION_COOKIE_NAME } from '$lib/server/session-cookie.js';
import { handle, _resetLaunchCache } from './hooks.server.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function seedSetupComplete(stackDir: string): void {
  const kvDir = join(stackDir, '..', '..', 'knowledge', 'env');
  mkdirSync(kvDir, { recursive: true });
  writeFileSync(join(kvDir, 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
}

function makeEvent(path: string, token: string | null, accept = 'application/json'): RequestEvent {
  const url = new URL(`http://localhost:3880${path}`);
  const headers: Record<string, string> = {
    host: 'localhost:3880',
    accept,
  };
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;

  return {
    url,
    request: new Request(url.toString(), { headers }),
    params: {},
    locals: {} as App.Locals,
    route: { id: path },
    platform: undefined,
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
    cookies: {} as ReturnType<RequestEvent['cookies']['get']> extends string ? RequestEvent['cookies'] : RequestEvent['cookies'],
  } as unknown as RequestEvent;
}

const resolve = () => Promise.resolve(new Response('ok', { status: 200 }));

// ── tests ─────────────────────────────────────────────────────────────────────

describe('hooks.server — sliding renewal', () => {
  beforeEach(() => {
    process.env.PORT = '3880';
    const state = resetState('test-admin-pw');
    seedSetupComplete(state.stackDir);
  });

  afterEach(() => {
    delete process.env.PORT;
  });

  test('admin request gets a NEW op_session cookie (sliding window extends TTL)', async () => {
    const originalToken = createSession();
    const event = makeEvent('/admin/containers/list', originalToken);

    const response = await handle({ event, resolve });

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie, 'response must include Set-Cookie').toContain(`${SESSION_COOKIE_NAME}=`);

    // Extract the new token value from the Set-Cookie header.
    const match = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    expect(match, 'Set-Cookie must contain a session token').toBeTruthy();
    const newToken = match![1];

    // The new token must be DIFFERENT from the original.
    // If it were the same, the sliding window would never extend the expiry.
    expect(newToken).not.toBe(originalToken);
  });

  test('non-admin request does not get a renewal cookie', async () => {
    const event = makeEvent('/admin/containers/list', null);

    const response = await handle({ event, resolve });

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain(`${SESSION_COOKIE_NAME}=`);
  });

  test('first-run document navigation routes to splash instead of setup', async () => {
    const state = resetState('test-admin-pw');
    const kvDir = join(state.stackDir, '..', '..', 'knowledge', 'env');
    mkdirSync(kvDir, { recursive: true });
    writeFileSync(join(kvDir, 'stack.env'), 'OP_SETUP_COMPLETE=false\n');

    const event = makeEvent('/', null, 'text/html');

    await expect(handle({ event, resolve })).rejects.toMatchObject({ location: '/splash' });
  });

  test('a pending migration forces /chat to /splash (migration outranks stack health)', async () => {
    // Seed a layout-v1 home with an inert channels.compose.yml → a real pending
    // 1→2 migration. Even if the stack were healthy (chat would normally be the
    // destination), the migration gate must route /chat → /splash.
    const state = resetState('test-admin-pw');
    const kvDir = join(state.stackDir, '..', '..', 'knowledge', 'env');
    mkdirSync(kvDir, { recursive: true });
    writeFileSync(join(kvDir, 'stack.env'), 'OP_SETUP_COMPLETE=true\nOP_LAYOUT_VERSION=1\n');
    mkdirSync(state.stackDir, { recursive: true });
    writeFileSync(join(state.stackDir, 'core.compose.yml'), 'services: {}\n');
    writeFileSync(join(state.stackDir, 'channels.compose.yml'), 'services: {}\n');
    _resetLaunchCache(); // resolve fresh against THIS home (the 5s cache is module-level)

    const event = makeEvent('/chat', null, 'text/html');
    await expect(handle({ event, resolve })).rejects.toMatchObject({ location: '/splash' });
  });

  test('proxy data requests are NOT launch-redirected (chat SSE/session must reach the route)', async () => {
    // Regression: the launch-routing guard must exempt /proxy/* like /api/ and
    // /admin/. Otherwise the chat's /proxy/assistant/event SSE (and session POST)
    // get 302'd to an HTML page, the EventSource can't parse it, and it enters a
    // reconnect loop ("Failed to start session: Unexpected token '<', <!doctype").
    const event = makeEvent('/proxy/assistant/event', null, 'text/event-stream');
    const response = await handle({ event, resolve });
    expect(response.status).toBe(200); // reached the route, not redirected to HTML
  });
});
