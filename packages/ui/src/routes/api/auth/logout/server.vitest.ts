/**
 * Route-level tests for POST /api/auth/logout.
 *
 * Previously untested anywhere (3.4). Logout must always succeed (idempotent
 * — no auth required, matching a browser that may already be logged out) and
 * must revoke the presented token so it fails validateSession() afterwards.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { POST } from './+server.js';
import { createSession, validateSession, _clearSessions } from '$lib/server/session-store.js';

const ENV_KEY = 'OP_UI_LOGIN_PASSWORD';
let savedEnv: string | undefined;

function makeLogoutEvent(cookie?: string): Parameters<typeof POST>[0] {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  return {
    request: new Request('http://localhost/api/auth/logout', { method: 'POST', headers }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = 'correct-password';
  _clearSessions();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  _clearSessions();
});

describe('POST /api/auth/logout', () => {
  test('returns 200 ok and clears the cookie even with no cookie presented', async () => {
    const res = await POST(makeLogoutEvent());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toMatch(/^op_session=;/);
    expect(setCookie).toContain('Max-Age=0');
  });

  test('revokes a real, currently-valid session token so it fails validation afterward', async () => {
    const token = createSession();
    expect(validateSession(token)).toBe(true);

    const res = await POST(makeLogoutEvent(`op_session=${token}`));
    expect(res.status).toBe(200);

    expect(validateSession(token)).toBe(false);
  });

  test('an already-revoked (or garbage) cookie still returns 200, not an error', async () => {
    const res = await POST(makeLogoutEvent('op_session=garbage-token-not-real'));
    expect(res.status).toBe(200);
  });
});
