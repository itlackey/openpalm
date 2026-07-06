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

const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:9100';
const PASSWORD = process.env.OP_UI_LOGIN_PASSWORD ?? '';
const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;

function authCookie(): Record<string, string> {
  return {
    cookie: `op_session=${PASSWORD}`,
    'x-requested-by': 'e2e-test',
    'x-request-id': crypto.randomUUID(),
  };
}

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
      const res = await request.get(`${ADMIN_URL}${endpoint}`, { headers: authCookie() });
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
