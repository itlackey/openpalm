/**
 * Admin Health & Connections — MANUAL smoke script (NOT an automated test).
 *
 * Renamed from `.pw.ts` to `.manual.ts` so it no longer runs as part
 * of the default Playwright suite. Requires a live dev stack +
 * standalone UI listening on ADMIN_URL. See e2e/README.md for the
 * convention. Self-contained vitest coverage of /admin/health +
 * /admin/providers (mocking @openpalm/lib) is a worthwhile follow-up.
 *
 * Validates:
 * - GET /admin/health: session probe (auth gate, assistant reachability)
 * - GET /admin/providers: Connections tab availability with running assistant
 *
 * Run with:
 *   RUN_DOCKER_STACK_TESTS=1 OP_UI_LOGIN_PASSWORD=dev-admin-token bun run ui:test:e2e
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

  test('GET /admin/health returns 401 without auth', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/health`, {
      headers: { 'x-request-id': crypto.randomUUID() },
    });
    expect(res.status()).toBe(401);
  });

  test('GET /admin/health returns 200 with valid token', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/health`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('GET /admin/health includes opencode availability flag', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/health`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body.opencode).toBe('boolean');
  });

  test('GET /admin/health reports opencode reachable when assistant is running', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/health`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // Assistant container is running — opencode should be true
    expect(body.opencode).toBe(true);
  });
});

test.describe('Connections Tab — Providers', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

  test('GET /admin/providers returns 401 without auth', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/providers`, {
      headers: { 'x-request-id': crypto.randomUUID() },
    });
    expect(res.status()).toBe(401);
  });

  test('GET /admin/providers returns available:true when assistant is running', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/providers`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // Assistant is running so providers page should be available
    expect(body.available).toBe(true);
  });

  test('GET /admin/providers returns providers array', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/providers`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.length).toBeGreaterThan(0);
  });

  test('GET /admin/providers includes stats', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/providers`, { headers: headers() });
    const body = await res.json();
    expect(typeof body.stats?.total).toBe('number');
    expect(typeof body.stats?.connected).toBe('number');
  });
});
