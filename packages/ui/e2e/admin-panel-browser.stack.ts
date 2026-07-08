/**
 * Admin panel browser smoke — stack integration test.
 *
 * Collected by Playwright when RUN_DOCKER_STACK_TESTS=1 (*.stack.ts pattern).
 * Run via: ./scripts/dev-e2e-test.sh --skip-build --playwright
 *
 * Loads the admin panel in a real browser with auth, then verifies:
 *  - Overview tab renders and shows at least one running container
 *  - Logs tab loads output after clicking Load Logs (not raw error text)
 *  - Connections tab shows provider list (not the raw pageState.error)
 *  - Secrets tab renders the vault key list
 */

import { test, expect } from '@playwright/test';
import { loginBrowserContext } from './auth-helpers';

const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:9100';
const HOST_URL = `${ADMIN_URL}/host`;
const PASSWORD = process.env.OP_UI_LOGIN_PASSWORD ?? '';
const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;

async function withAuth(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext) {
  await loginBrowserContext(request, page.context(), ADMIN_URL, PASSWORD);
}

test.describe('Admin panel browser smoke', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');
  test.setTimeout(45_000);

  test('admin panel loads and shows the Overview tab by default', async ({ page, request }) => {
    await withAuth(page, request);
    await page.goto(HOST_URL, { waitUntil: 'networkidle' });

    // Overview status is the default host-console landing view.
    const statusCard = page.getByRole('status');
    await expect(statusCard).toBeVisible({ timeout: 15_000 });
    await expect(statusCard.getByRole('button', { name: /check for updates/i })).toBeVisible();
  });

  test('Overview tab shows at least one running container', async ({ page, request }) => {
    await withAuth(page, request);
    await page.goto(HOST_URL, { waitUntil: 'networkidle' });

    await page.getByRole('tab', { name: /systems/i }).click();
    await expect(page.getByRole('heading', { name: /container status/i })).toBeVisible({ timeout: 15_000 });

    // At least the core assistant row must be visible in a running stack.
    await expect(page.getByRole('button', { name: /assistant/i })).toBeVisible({ timeout: 10_000 });
  });

  test('Logs tab shows output after Load Logs — not raw error text', async ({ page, request }) => {
    await withAuth(page, request);
    await page.goto(HOST_URL, { waitUntil: 'networkidle' });

    // Navigate to the Journal tab
    const logsTab = page.getByRole('tab', { name: /journal/i });
    await expect(logsTab).toBeVisible({ timeout: 10_000 });
    await logsTab.click();

    // Pick any service from the selector
    const serviceSelect = page.locator('#log-service');
    await expect(serviceSelect).toBeVisible({ timeout: 5_000 });
    await serviceSelect.selectOption({ index: 1 });

    // Click Load Logs
    const loadBtn = page.getByRole('button', { name: /load service logs/i });
    await expect(loadBtn).toBeVisible();
    await loadBtn.click();

    // Must not show a raw "fetch failed" or error object as string
    await expect(page.locator('text=fetch failed')).not.toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=[object Object]')).not.toBeVisible();

    // Either real log output or the "no output" placeholder — both are acceptable
    // but we must not see an unhandled error string
    await expect(page.locator('[data-testid="log-output"], .log-output, pre')).toBeVisible({ timeout: 10_000 });
  });

  test('Connections tab renders provider list — not raw error text', async ({ page, request }) => {
    await withAuth(page, request);
    await page.goto(HOST_URL, { waitUntil: 'networkidle' });

    const connectionsTab = page.getByRole('tab', { name: /mind/i });
    await expect(connectionsTab).toBeVisible({ timeout: 10_000 });
    await connectionsTab.click();

    // Either providers are listed or the "assistant not reachable" message appears.
    // Neither case should show raw error text.
    await expect(page.locator('text=fetch failed')).not.toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=[object Object]')).not.toBeVisible();

    await expect(page.getByRole('heading', { name: /connections/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /add provider/i })).toBeVisible();
  });

  test('Secrets tab renders the vault key list', async ({ page, request }) => {
    await withAuth(page, request);
    await page.goto(HOST_URL, { waitUntil: 'networkidle' });

    await page.getByRole('tab', { name: /knowledge/i }).click();
    const secretsTab = page.getByRole('tab', { name: /secrets/i });
    await expect(secretsTab).toBeVisible({ timeout: 10_000 });
    await secretsTab.click();

    await expect(page.getByRole('heading', { name: /secrets/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /refresh/i })).toBeVisible();
  });

  test('unauthenticated request to admin panel is redirected to auth gate', async ({ page }) => {
    // No cookie set
    await page.goto(HOST_URL);
    // Should land on a login/auth page, not show admin content
    await expect(page).not.toHaveURL(/\/setup/);
    // The message input or containers overview must NOT be visible without auth
    await expect(page.getByRole('heading', { name: /container status/i })).not.toBeVisible({ timeout: 5_000 });
  });
});
