/**
 * Admin Health & Connections — stack integration test.
 *
 * Collected by Playwright when RUN_DOCKER_STACK_TESTS=1 (*.stack.ts pattern).
 * Run via: ./scripts/dev-e2e-test.sh --skip-build --playwright
 *
 * Validates:
 * - GET /api/host/health: session probe (auth gate, assistant reachability)
 * - GET /api/host/providers: Connections tab availability with running assistant
 */

import { expect, test } from '@playwright/test';

const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:9100';
const OP_UI_LOGIN_PASSWORD = process.env.OP_UI_LOGIN_PASSWORD ?? '';

// Phase 2 (auth/proxy refactor): x-admin-token header fallback removed.
// E2E tests authenticate via the op_session cookie. The cookie value is the
// admin secret (same value the operator types into the wizard); the host UI
// server treats a request bearing the correct cookie as an authenticated
// admin session.
function headers(): Record<string, string> {
  return {
    cookie: `op_session=${OP_UI_LOGIN_PASSWORD}`,
    'x-requested-by': 'e2e-test',
    'x-request-id': crypto.randomUUID(),
    'content-type': 'application/json',
  };
}

const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;

test.describe('Admin Health Endpoint', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

  test('GET /api/host/health returns 401 without auth', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/api/host/health`, {
      headers: { 'x-request-id': crypto.randomUUID() },
    });
    expect(res.status()).toBe(401);
  });

  test('GET /api/host/health returns 200 with valid token', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/api/host/health`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('GET /api/host/health includes opencode availability flag', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/api/host/health`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body.opencode).toBe('boolean');
  });

  test('GET /api/host/health reports opencode reachable when assistant is running', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/api/host/health`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // Assistant container is running — opencode should be true
    expect(body.opencode).toBe(true);
  });
});

test.describe('Connections Tab — Providers', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

  test('GET /api/host/providers returns 401 without auth', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/api/host/providers`, {
      headers: { 'x-request-id': crypto.randomUUID() },
    });
    expect(res.status()).toBe(401);
  });

  test('GET /api/host/providers returns available:true when assistant is running', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/api/host/providers`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // Assistant is running so providers page should be available
    expect(body.available).toBe(true);
  });

  test('GET /api/host/providers returns providers array', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/api/host/providers`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.length).toBeGreaterThan(0);
  });

  test('GET /api/host/providers includes stats', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/api/host/providers`, { headers: headers() });
    const body = await res.json();
    expect(typeof body.stats?.total).toBe('number');
    expect(typeof body.stats?.connected).toBe('number');
  });
});

test.describe('Guardian liveness', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

  test('GET /guardian/health returns 200 via admin proxy (no auth required)', async ({ request }) => {
    // /guardian/health is in SETUP_PATHS — accessible without a session cookie
    const res = await request.get(`${ADMIN_URL}/guardian/health`, {
      headers: { 'x-request-id': crypto.randomUUID() },
    });
    expect(res.status()).toBe(200);
  });

  test('GET /guardian/health response body indicates guardian is up', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/guardian/health`, {
      headers: { 'x-request-id': crypto.randomUUID() },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // Guardian health returns { status: 'ok' } or similar
    expect(body.status ?? body.ok).toBeTruthy();
  });

  test('GET /api/host/health includes opencode field (guardian has no separate health field)', async ({ request }) => {
    // Admin health covers the OpenCode assistant. Guardian liveness is separate
    // (proxied above). Verify the admin health response shape hasn't regressed.
    const res = await request.get(`${ADMIN_URL}/api/host/health`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.opencode).toBe('boolean');
    expect(body.endpoint).toBeDefined();
  });
});
