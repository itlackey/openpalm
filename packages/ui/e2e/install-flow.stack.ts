/**
 * Install flow — wizard browser walk-through (stack integration test).
 *
 * Collected by Playwright when RUN_DOCKER_STACK_TESTS=1 (*.stack.ts pattern).
 * Run via: ./scripts/dev-e2e-test.sh --skip-build --playwright
 *
 * Temporarily resets state/stack.env so the wizard guard redirects / to /setup,
 * then walks every step to the Review page and verifies the Install button
 * is present and enabled. Does NOT click Install — the deploy API contract
 * is exercised by setup-wizard-api.stack.ts; rerunning a real compose up
 * in the same test environment would cause a destructive config overwrite.
 *
 * Restores stack.env in afterAll so subsequent tests see a complete stack.
 */

import { test, expect, type Page } from '@playwright/test';
import { resetWizardState, restoreWizardState, resolveOpHome } from './wizard-reset.ts';

const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:9100';
const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;

async function allowEmptyInstallIfNeeded(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: /i'll set this up later/i });
  if (await button.isVisible()) await button.click();
}

test.describe('Install flow — wizard browser walk-through', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');
  test.setTimeout(60_000);

  const opHome = resolveOpHome();

  test.beforeAll(() => {
    resetWizardState(opHome);
  });

  test.afterAll(() => {
    restoreWizardState(opHome);
  });

  test('GET / redirects to /setup when setup is not complete', async ({ page }) => {
    const res = await page.goto(`${ADMIN_URL}/`);
    expect(res?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/setup$/);
  });

  test('Connect step renders after the hidden System Check passes', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/setup`);
    await expect(page.locator('[data-testid="step-models"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /connect your ai brain/i })).toBeVisible();
    await expect(page.locator('#btn-screen1-next')).toBeAttached();
  });

  test('Continue from Connect advances to Add-ons step', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/setup`);
    await expect(page.locator('[data-testid="step-models"]')).toBeVisible({ timeout: 15_000 });

    await allowEmptyInstallIfNeeded(page);
    const continueBtn = page.locator('#btn-screen1-next');
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();

    await expect(page.locator('#step-2')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: /optional extras/i })).toBeVisible();
  });

  test('Add-ons step shows optional extras and Continue button', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/setup`);

    await expect(page.locator('[data-testid="step-models"]')).toBeVisible({ timeout: 15_000 });
    await allowEmptyInstallIfNeeded(page);
    await page.locator('#btn-screen1-next').click();

    await expect(page.locator('#step-2')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /^continue$/i })).toBeVisible();
  });

  test('Review step shows Install button when reached via Continue', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/setup`);

    // Step 1: Connect → Add-ons
    await expect(page.locator('[data-testid="step-models"]')).toBeVisible({ timeout: 15_000 });
    await allowEmptyInstallIfNeeded(page);
    await page.locator('#btn-screen1-next').click();

    // Step 2: Add-ons → Finish
    await expect(page.locator('#step-2')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /^continue$/i }).click();

    // Review & Install step must show the Install button.
    await expect(page.getByRole('button', { name: /^install$/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /^install$/i })).toBeEnabled();
  });
});
