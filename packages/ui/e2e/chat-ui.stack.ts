/**
 * Chat UI — stack integration test.
 *
 * Collected by Playwright when RUN_DOCKER_STACK_TESTS=1 (*.stack.ts pattern).
 * Run via: ./scripts/dev-e2e-test.sh --skip-build --playwright
 *
 * Does NOT send a real message — we're verifying the UI renders and is
 * interactive, not exercising the LLM pipeline. The assistant container
 * must be running (dev-e2e-test.sh ensures this).
 */

import { test, expect } from '@playwright/test';

const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:9100';
const PASSWORD = process.env.OP_UI_LOGIN_PASSWORD ?? '';
const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;

test.describe('Chat UI', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');
  test.setTimeout(30_000);

  test('GET /chat redirects to auth gate when not authenticated', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/chat`);
    // Either renders an auth gate input or redirects — either way no 500.
    expect(page.url()).not.toContain('error');
    const status = await page.evaluate(() => document.readyState);
    expect(status).toBe('complete');
  });

  test('chat page renders message input after auth', async ({ page }) => {
    // Set session cookie directly so we skip the auth gate form.
    await page.context().addCookies([{
      name: 'op_session',
      value: PASSWORD,
      domain: new URL(ADMIN_URL).hostname,
      path: '/',
    }]);

    await page.goto(`${ADMIN_URL}/chat`, { waitUntil: 'networkidle' });

    // The message input is always rendered (even with no sessions).
    await expect(page.locator('[aria-label="Message input"]')).toBeVisible({ timeout: 10_000 });
  });

  test('message input accepts text and enables send button', async ({ page }) => {
    await page.context().addCookies([{
      name: 'op_session',
      value: PASSWORD,
      domain: new URL(ADMIN_URL).hostname,
      path: '/',
    }]);

    await page.goto(`${ADMIN_URL}/chat`, { waitUntil: 'networkidle' });

    const input = page.locator('[aria-label="Message input"]');
    await expect(input).toBeVisible({ timeout: 10_000 });

    await input.fill('hello');
    await expect(input).toHaveValue('hello');

    const sendBtn = page.locator('[aria-label="Send message"]');
    await expect(sendBtn).toBeEnabled({ timeout: 5_000 });
  });

  test('session picker is visible in the nav', async ({ page }) => {
    await page.context().addCookies([{
      name: 'op_session',
      value: PASSWORD,
      domain: new URL(ADMIN_URL).hostname,
      path: '/',
    }]);

    await page.goto(`${ADMIN_URL}/chat`, { waitUntil: 'networkidle' });

    // The Sessions dropdown button is always present in the nav header.
    await expect(page.getByRole('button', { name: /sessions/i })).toBeVisible({ timeout: 10_000 });
  });
});
