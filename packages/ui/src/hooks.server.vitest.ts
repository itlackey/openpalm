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
import { handle } from './hooks.server.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function seedSetupComplete(stackDir: string): void {
  const kvDir = join(stackDir, '..', '..', 'knowledge', 'env');
  mkdirSync(kvDir, { recursive: true });
  writeFileSync(join(kvDir, 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
}

function makeEvent(path: string, token: string | null): RequestEvent {
  const url = new URL(`http://localhost:3880${path}`);
  const headers: Record<string, string> = {
    host: 'localhost:3880',
    accept: 'application/json',
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
});
