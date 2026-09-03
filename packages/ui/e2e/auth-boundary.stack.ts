/**
 * Auth boundary sweep — stack integration test.
 *
 * Collected by Playwright when RUN_DOCKER_STACK_TESTS=1 (*.stack.ts pattern).
 * Run via: ./scripts/dev-e2e-test.sh --skip-build --playwright
 *
 * Systematically verifies that every critical admin endpoint:
 *  - Returns 401 with no auth
 *  - Returns 401 with a wrong cookie
 *  - Returns 200 (or non-401) with the correct op_session cookie
 *
 * This is a pure API test — no browser context needed.
 */

import { test, expect } from '@playwright/test';
import { loginAndGetSessionCookie, loginHeaders } from './auth-helpers';

const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:9100';
const PASSWORD = process.env.OP_UI_LOGIN_PASSWORD ?? '';
const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;

function wrongCookie(): Record<string, string> {
  return {
    cookie: 'op_session=definitely-wrong-token',
    'x-requested-by': 'e2e-test',
    'x-request-id': crypto.randomUUID(),
  };
}

function noAuth(): Record<string, string> {
  return {
    'x-request-id': crypto.randomUUID(),
  };
}

// Endpoints that must be gated by admin auth (GET unless noted)
const PROTECTED_ENDPOINTS = [
  '/api/host/health',
  '/api/host/providers',
  '/api/host/secrets/user-env',
  '/api/host/containers/list',
  '/api/host/automations',
];

test.describe('Auth boundary — protected endpoints', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');
  test.setTimeout(30_000);

  for (const endpoint of PROTECTED_ENDPOINTS) {
    test(`GET ${endpoint} returns 401 without auth`, async ({ request }) => {
      const res = await request.get(`${ADMIN_URL}${endpoint}`, { headers: noAuth() });
      expect(res.status()).toBe(401);
    });

    test(`GET ${endpoint} returns 401 with wrong cookie`, async ({ request }) => {
      const res = await request.get(`${ADMIN_URL}${endpoint}`, { headers: wrongCookie() });
      expect(res.status()).toBe(401);
    });

    test(`GET ${endpoint} returns 200 with valid cookie`, async ({ request }) => {
      const res = await request.get(`${ADMIN_URL}${endpoint}`, { headers: await loginHeaders(request, ADMIN_URL, PASSWORD) });
      // Allow 200 or 503 (service unavailable is OK — just not an auth failure)
      expect(res.status()).not.toBe(401);
      expect(res.status()).not.toBe(403);
      expect(res.status()).toBeLessThan(500);
    });
  }
});

test.describe('Auth boundary — write endpoints', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');
  test.setTimeout(30_000);

  test('POST /api/host/secrets/user-env returns 401 without auth', async ({ request }) => {
    const res = await request.post(`${ADMIN_URL}/api/host/secrets/user-env`, {
      headers: { ...noAuth(), 'content-type': 'application/json' },
      data: { key: 'E2E_TEST', value: 'test' },
    });
    expect(res.status()).toBe(401);
  });

  test('POST /api/host/secrets/user-env returns 401 with wrong cookie', async ({ request }) => {
    const res = await request.post(`${ADMIN_URL}/api/host/secrets/user-env`, {
      headers: { ...wrongCookie(), 'content-type': 'application/json' },
      data: { key: 'E2E_TEST', value: 'test' },
    });
    expect(res.status()).toBe(401);
  });

  test('DELETE /api/host/secrets/user-env returns 401 without auth', async ({ request }) => {
    const res = await request.delete(`${ADMIN_URL}/api/host/secrets/user-env?key=E2E_TEST`, {
      headers: noAuth(),
    });
    expect(res.status()).toBe(401);
  });
});

test.describe('Auth boundary — public paths remain accessible', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');
  test.setTimeout(15_000);

  test('GET /health returns 200 without auth', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/health`, {
      headers: { 'x-request-id': crypto.randomUUID() },
    });
    // SvelteKit health or 404 — just not an auth block
    expect(res.status()).not.toBe(401);
  });

  test('GET /guardian/health returns 200 without auth', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/guardian/health`, {
      headers: { 'x-request-id': crypto.randomUUID() },
    });
    expect(res.status()).toBe(200);
  });
});

// #678 — the host admin UI and the container-served assistant UI must hold
// INDEPENDENT sessions. The host surface issues `op_session`; the
// container-served UI reads `op_session_assistant` (session-cookie.ts). The
// distinct names ARE the mechanism, so this asserts the consequence: a session
// minted on one surface is not a session on the other.
test.describe('Auth boundary — host and assistant sessions are independent', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');
  test.setTimeout(30_000);

  const CONTAINER_UI_URL = process.env.CONTAINER_UI_URL ?? '';

  test('a host admin session buys nothing on the container-served UI', async ({ request }) => {
    // Exported by scripts/dev-e2e-test.sh. Missing means the runner changed,
    // which must fail rather than quietly skip — this suite forbids skips.
    expect(CONTAINER_UI_URL, 'CONTAINER_UI_URL not exported by the stack runner').toBeTruthy();

    const hostSession = await loginAndGetSessionCookie(request, ADMIN_URL, PASSWORD);
    expect(hostSession.name).toBe('op_session');

    const probe = '/api/host/containers/list';
    const cookieHeader = `${hostSession.name}=${hostSession.value}`;

    // The session works on the surface that issued it.
    const onHost = await request.get(`${ADMIN_URL}${probe}`, {
      headers: { cookie: cookieHeader, 'x-requested-by': 'e2e-test', 'x-request-id': crypto.randomUUID() },
    });
    expect(onHost.status()).toBe(200);

    // On the other surface it must confer NOTHING — asserted as "the same
    // answer you get with no cookie at all", not as a specific status code.
    // The container UI answers this path 403 (the host capability is not
    // served there) rather than 401, and pinning either number would test the
    // rejection style instead of the session boundary.
    const anonymous = await request.get(`${CONTAINER_UI_URL}${probe}`, {
      headers: { 'x-requested-by': 'e2e-test', 'x-request-id': crypto.randomUUID() },
    });
    const withHostCookie = await request.get(`${CONTAINER_UI_URL}${probe}`, {
      headers: { cookie: cookieHeader, 'x-requested-by': 'e2e-test', 'x-request-id': crypto.randomUUID() },
    });

    expect(withHostCookie.status()).toBe(anonymous.status());
    expect(withHostCookie.status()).not.toBe(200);
  });
});
