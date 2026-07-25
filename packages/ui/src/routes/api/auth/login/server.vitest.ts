/**
 * Route-level tests for POST /api/auth/login.
 *
 * Previously untested anywhere (3.4) — the route mints the `op_session`
 * cookie operators authenticate with for every subsequent privileged API call, so
 * its four branches (misconfigured, bad body, wrong password, success) are
 * the entire login contract.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { POST } from './+server.js';
import { _clearSessions } from '$lib/server/session-store.js';
import { _resetLoginThrottle } from '$lib/server/login-throttle.js';

const ENV_KEY = 'OP_UI_LOGIN_PASSWORD';
let savedEnv: string | undefined;

function makeLoginEvent(
  body: unknown,
  asJson = true,
  clientAddress = '127.0.0.1',
): Parameters<typeof POST>[0] {
  return {
    getClientAddress: () => clientAddress,
    request: asJson
      ? new Request('http://localhost/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      : new Request('http://localhost/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'not-json{{{',
        }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  _clearSessions();
  // Throttle state is module-level and would otherwise leak between tests.
  _resetLoginThrottle();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  _clearSessions();
  _resetLoginThrottle();
});

describe('POST /api/auth/login', () => {
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

describe('POST /api/auth/login — brute-force throttling', () => {
  test('429s with a Retry-After once the free attempts are spent', async () => {
    process.env[ENV_KEY] = 'correct-horse';

    // Five wrong passwords still answer 401 — the block is armed by the fifth
    // failure, so it takes effect on the attempt AFTER it, not during.
    for (let n = 0; n < 5; n += 1) {
      const res = await POST(makeLoginEvent({ password: 'wrong' }));
      expect(res.status).toBe(401);
    }

    const blocked = await POST(makeLoginEvent({ password: 'wrong' }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect(await blocked.json()).toMatchObject({ error: 'too_many_attempts' });
  });

  test('the correct password is refused too while blocked — the gate is the attempt, not the guess', async () => {
    process.env[ENV_KEY] = 'correct-horse';
    for (let n = 0; n < 5; n += 1) await POST(makeLoginEvent({ password: 'wrong' }));

    const res = await POST(makeLoginEvent({ password: 'correct-horse' }));
    expect(res.status).toBe(429);
  });

  test('one attacker cannot lock out another client', async () => {
    process.env[ENV_KEY] = 'correct-horse';
    for (let n = 0; n < 5; n += 1) {
      await POST(makeLoginEvent({ password: 'wrong' }, true, '10.0.0.9'));
    }
    expect((await POST(makeLoginEvent({ password: 'wrong' }, true, '10.0.0.9'))).status).toBe(429);

    const other = await POST(makeLoginEvent({ password: 'correct-horse' }, true, '192.168.1.50'));
    expect(other.status).toBe(200);
  });

  test('a successful sign-in clears the counter', async () => {
    process.env[ENV_KEY] = 'correct-horse';
    for (let n = 0; n < 3; n += 1) await POST(makeLoginEvent({ password: 'wrong' }));

    expect((await POST(makeLoginEvent({ password: 'correct-horse' }))).status).toBe(200);

    // Without the reset the next three failures would cross the threshold.
    for (let n = 0; n < 3; n += 1) {
      expect((await POST(makeLoginEvent({ password: 'wrong' }))).status).toBe(401);
    }
  });
});
