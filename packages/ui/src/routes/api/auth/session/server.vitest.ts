/**
 * Route-level tests for POST /api/auth/session.
 *
 * Previously untested anywhere (3.4). Kept as a login alias (same password
 * check, same cookie issuance) — these tests mirror the login route's,
 * confirming the alias actually behaves identically rather than drifting.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { POST } from './+server.js';
import { _clearSessions } from '$lib/server/session-store.js';

const ENV_KEY = 'OP_UI_LOGIN_PASSWORD';
let savedEnv: string | undefined;

function makeSessionEvent(body: unknown, asJson = true): Parameters<typeof POST>[0] {
  return {
    request: asJson
      ? new Request('http://localhost/api/auth/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      : new Request('http://localhost/api/auth/session', {
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

describe('POST /api/auth/session', () => {
  test('returns 503 admin_not_configured when no login password is set', async () => {
    delete process.env[ENV_KEY];
    const res = await POST(makeSessionEvent({ password: 'anything' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('admin_not_configured');
  });

  test('returns 400 bad_request for invalid JSON body', async () => {
    process.env[ENV_KEY] = 'correct-password';
    const res = await POST(makeSessionEvent(undefined, false));
    expect(res.status).toBe(400);
  });

  test('returns 400 bad_request when password field is missing', async () => {
    process.env[ENV_KEY] = 'correct-password';
    const res = await POST(makeSessionEvent({}));
    expect(res.status).toBe(400);
  });

  test('returns 401 unauthorized for a wrong password', async () => {
    process.env[ENV_KEY] = 'correct-password';
    const res = await POST(makeSessionEvent({ password: 'wrong-password' }));
    expect(res.status).toBe(401);
  });

  test('returns 200 with an op_session Set-Cookie for the correct password', async () => {
    process.env[ENV_KEY] = 'correct-password';
    const res = await POST(makeSessionEvent({ password: 'correct-password' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toMatch(/^op_session=/);
  });
});
