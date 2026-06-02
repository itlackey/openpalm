/**
 * Secrets CRUD — stack integration test.
 *
 * Collected by Playwright when RUN_DOCKER_STACK_TESTS=1 (*.stack.ts pattern).
 * Run via: ./scripts/dev-e2e-test.sh --skip-build --playwright
 *
 * Tests the /admin/secrets/user-env API end-to-end:
 *  - POST: write a test key
 *  - GET: verify key appears in the list (value is never returned)
 *  - DELETE: remove the key
 *  - GET: confirm key is gone
 *  - Input validation: 400 on bad key names, 400 on empty value
 *
 * Uses a clearly scoped key name (E2E_SECRETS_TEST_KEY) so accidental
 * leftover state is obvious and harmless.
 */

import { test, expect } from '@playwright/test';

const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:9100';
const PASSWORD = process.env.OP_UI_LOGIN_PASSWORD ?? '';
const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;

const TEST_KEY = 'E2E_SECRETS_TEST_KEY';
const VAULT_URL = `${ADMIN_URL}/admin/secrets/user-env`;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: `op_session=${PASSWORD}`,
    'x-requested-by': 'e2e-test',
    'x-request-id': crypto.randomUUID(),
    'content-type': 'application/json',
    ...extra,
  };
}

test.describe('Secrets CRUD', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');
  test.setTimeout(30_000);

  test.afterAll(async ({ request }) => {
    // Best-effort cleanup in case a test failed mid-way.
    await request.delete(`${VAULT_URL}?key=${TEST_KEY}`, { headers: headers() }).catch(() => {});
  });

  test('GET /admin/secrets/user-env returns env metadata', async ({ request }) => {
    const res = await request.get(VAULT_URL, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.provider).toBe('akm');
    expect(body.envRef).toBe('env:user');
    expect(Array.isArray(body.keys)).toBe(true);
  });

  test('POST writes a key and returns ok:true', async ({ request }) => {
    const res = await request.post(VAULT_URL, {
      headers: headers(),
      data: { key: TEST_KEY, value: 'e2e-test-value' },
    });
    expect(res.ok(), `POST failed: ${res.status()}`).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.key).toBe(TEST_KEY);
  });

  test('GET after POST includes the new key in the list', async ({ request }) => {
    const res = await request.get(VAULT_URL, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.keys).toContain(TEST_KEY);
  });

  test('GET never returns secret values — only key names', async ({ request }) => {
    const res = await request.get(VAULT_URL, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // The response shape must only have: provider, envRef, keys
    expect(body).not.toHaveProperty('values');
    // keys is an array of strings (names), not objects with values
    for (const k of body.keys) {
      expect(typeof k).toBe('string');
    }
  });

  test('DELETE removes the key and returns ok:true', async ({ request }) => {
    const res = await request.delete(`${VAULT_URL}?key=${TEST_KEY}`, { headers: headers() });
    expect(res.ok(), `DELETE failed: ${res.status()}`).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.key).toBe(TEST_KEY);
  });

  test('GET after DELETE does not include the key', async ({ request }) => {
    const res = await request.get(VAULT_URL, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.keys).not.toContain(TEST_KEY);
  });
});

test.describe('Secrets — input validation', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');
  test.setTimeout(15_000);

  test('POST returns 400 for key with invalid characters', async ({ request }) => {
    const res = await request.post(VAULT_URL, {
      headers: headers(),
      data: { key: 'invalid-key-with-dashes', value: 'somevalue' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST returns 400 for key starting with a digit', async ({ request }) => {
    const res = await request.post(VAULT_URL, {
      headers: headers(),
      data: { key: '1_STARTS_WITH_DIGIT', value: 'somevalue' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST returns 400 for empty value', async ({ request }) => {
    const res = await request.post(VAULT_URL, {
      headers: headers(),
      data: { key: 'VALID_KEY', value: '' },
    });
    expect(res.status()).toBe(400);
  });

  test('DELETE returns 400 for missing key parameter', async ({ request }) => {
    const res = await request.delete(VAULT_URL, { headers: headers() });
    expect(res.status()).toBe(400);
  });
});
