/**
 * Auth flow — self-contained Playwright contract test (mocked-lib subset, 3.4).
 *
 * Collected by the default `*.pw.ts` testMatch — runs against the built
 * preview server (see playwright.config.ts) with an isolated throwaway
 * OP_HOME and a known OP_UI_LOGIN_PASSWORD (no live stack, no host-side env
 * vars required). Carved out of auth-boundary.stack.ts's write-endpoint
 * sweep so this coverage runs on every CI push, not only against a live
 * compose stack.
 *
 * Covers, over real HTTP against the real adapter-node server (not a direct
 * handler call — see the server.vitest.ts route tests for that level):
 *   - login → session cookie authorizes a protected read endpoint → logout
 *     revokes it
 *   - wrong password is rejected
 *   - a mutating /api/host/containers/* endpoint enforces the same auth gate
 *     (no auth / wrong cookie → 401), without ever touching Docker
 */
import { test, expect } from '@playwright/test';

const PASSWORD = process.env.OP_UI_LOGIN_PASSWORD ?? 'e2e-mocked-password';

test.describe('Auth flow — login / session / logout (mocked-lib)', () => {
  test('wrong password is rejected with 401 and no cookie', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: { password: 'definitely-wrong' },
    });
    expect(res.status()).toBe(401);
    expect(res.headers()['set-cookie']).toBeUndefined();
  });

  test('missing password body returns 400', async ({ request }) => {
    const res = await request.post('/api/auth/login', { data: {} });
    expect(res.status()).toBe(400);
  });

  test('login → protected read → logout → protected read is 401 again', async ({ request }) => {
    // 1. Login with the correct password issues the op_session cookie.
    const loginRes = await request.post('/api/auth/login', {
      data: { password: PASSWORD },
    });
    expect(loginRes.status()).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.ok).toBe(true);

    // Playwright's `request` context is cookie-jar-aware per test — the
    // Set-Cookie from step 1 is automatically sent on subsequent requests
    // made with the same `request` fixture.
    const listRes = await request.get('/api/host/containers/list');
    expect(listRes.status()).not.toBe(401);
    expect(listRes.status()).toBeLessThan(500);

    // 2. Logout revokes the session.
    const logoutRes = await request.post('/api/auth/logout');
    expect(logoutRes.status()).toBe(200);

    // 3. The same cookie jar's now-revoked session must be rejected.
    const afterLogout = await request.get('/api/host/containers/list');
    expect(afterLogout.status()).toBe(401);
  });
});

test.describe('Auth flow — mutating containers/* endpoint enforces auth (mocked-lib)', () => {
  test('POST /api/host/containers/up returns 401 with no auth', async ({ request }) => {
    const res = await request.post('/api/host/containers/up', {
      data: { service: 'assistant' },
    });
    expect(res.status()).toBe(401);
  });

  test('POST /api/host/containers/up returns 401 with a forged cookie', async ({ request }) => {
    const res = await request.post('/api/host/containers/up', {
      headers: { cookie: 'op_session=forged-token-not-real' },
      data: { service: 'assistant' },
    });
    expect(res.status()).toBe(401);
  });
});
