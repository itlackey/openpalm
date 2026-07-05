/**
 * Route-level tests for POST /admin/auth/login.
 *
 * Previously untested anywhere (3.4) — the route mints the `op_session`
 * cookie operators authenticate with for every subsequent /admin/* call, so
 * its four branches (misconfigured, bad body, wrong password, success) are
 * the entire login contract.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { POST } from './+server.js';
import { _clearSessions } from '$lib/server/session-store.js';

const ENV_KEY = 'OP_UI_LOGIN_PASSWORD';
let savedEnv: string | undefined;

function makeLoginEvent(body: unknown, asJson = true): Parameters<typeof POST>[0] {
  return {
    request: asJson
      ? new Request('http://localhost/admin/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      : new Request('http://localhost/admin/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'not-json{{{',
        }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  _clearSessions();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  _clearSessions();
});

describe('POST /admin/auth/login', () => {
  test('returns 503 admin_not_configured when no login password is set', async () => {
    delete process.env[ENV_KEY];
    const res = await POST(makeLoginEvent({ password: 'anything' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('admin_not_configured');
  });

  test('returns 400 bad_request for invalid JSON body', async () => {
    process.env[ENV_KEY] = 'correct-password';
    const res = await POST(makeLoginEvent(undefined, false));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('bad_request');
  });

  test('returns 400 bad_request when password field is missing', async () => {
    process.env[ENV_KEY] = 'correct-password';
    const res = await POST(makeLoginEvent({}));
    expect(res.status).toBe(400);
  });

  test('returns 400 bad_request when password field is empty string', async () => {
    process.env[ENV_KEY] = 'correct-password';
    const res = await POST(makeLoginEvent({ password: '' }));
    expect(res.status).toBe(400);
  });

  test('returns 401 unauthorized for a wrong password', async () => {
    process.env[ENV_KEY] = 'correct-password';
    const res = await POST(makeLoginEvent({ password: 'wrong-password' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('returns 200 with an op_session Set-Cookie for the correct password', async () => {
    process.env[ENV_KEY] = 'correct-password';
    const res = await POST(makeLoginEvent({ password: 'correct-password' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.role).toBe('admin');

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toMatch(/^op_session=/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
  });
});
