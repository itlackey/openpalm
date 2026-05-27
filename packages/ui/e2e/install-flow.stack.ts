/**
 * Install flow — wizard browser walk-through (stack integration test).
 *
 * Collected by Playwright when RUN_DOCKER_STACK_TESTS=1 (*.stack.ts pattern).
 * Run via: ./scripts/dev-e2e-test.sh --skip-build --playwright
 *
 * Temporarily resets stack.env so the wizard guard redirects / to /setup,
 * then walks every step to the Review page and verifies the Install button
 * is present and enabled. Does NOT click Install — the deploy API contract
 * is exercised by setup-wizard-api.stack.ts; rerunning a real compose up
 * in the same test environment would cause a destructive config overwrite.
 *
 * Restores stack.env in afterAll so subsequent tests see a complete stack.
 */

import { test, expect } from '@playwright/test';
import { resetWizardState, restoreWizardState, resolveOpHome } from './wizard-reset.ts';

const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:9100';
const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;

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

  test('System Check step renders and Docker shows as available', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/setup`);
    await expect(page.locator('[data-testid="step-system-check"]')).toBeVisible({ timeout: 10_000 });

    // Wait for the docker probe to complete (the step transitions to pass state).
    await expect(page.locator('[data-testid="step-system-check"]')).toContainText('Docker', { timeout: 15_000 });

    // Continue button becomes enabled once system check passes.
    const continueBtn = page.locator('#btn-syscheck-next');
    await expect(continueBtn).toBeEnabled({ timeout: 15_000 });
  });

  test('Continue from System Check advances to Get Started step', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/setup`);
    await expect(page.locator('[data-testid="step-system-check"]')).toBeVisible({ timeout: 10_000 });

    const continueBtn = page.locator('#btn-syscheck-next');
    await expect(continueBtn).toBeEnabled({ timeout: 15_000 });
    await continueBtn.click();

    await expect(page.locator('[data-testid="step-welcome"]')).toBeVisible({ timeout: 10_000 });
  });

  test('Get Started step shows welcome content and Continue button', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/setup`);

    const continueBtn = page.locator('#btn-syscheck-next');
    await expect(continueBtn).toBeEnabled({ timeout: 15_000 });
    await continueBtn.click();

    await expect(page.locator('[data-testid="step-welcome"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /continue/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /use recommended defaults/i })).toBeVisible();
  });

  test('Review step shows Install button when reached via Continue', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/setup`);

    // Step 0: System Check → Continue
    const sysContinue = page.locator('#btn-syscheck-next');
    await expect(sysContinue).toBeEnabled({ timeout: 15_000 });
    await sysContinue.click();
    await expect(page.locator('[data-testid="step-welcome"]')).toBeVisible({ timeout: 10_000 });

    // Step 1: Get Started → Continue (auto-imports providers, may jump to Models)
    await page.getByRole('button', { name: /^continue$/i }).click();

    // Models step (step index 3) — wait for it regardless of provider auto-skip.
    await expect(page.locator('[data-testid="step-models"]')).toBeVisible({ timeout: 15_000 });

    // Advance through remaining steps to Review.
    // Step 3: Models → Voice Setup
    await page.getByRole('button', { name: /voice setup/i }).click();
    // Step 4: Voice → Continue
    await page.getByRole('button', { name: /^continue$/i }).click();
    // Step 5: Options → Review
    await page.getByRole('button', { name: /^review$/i }).click();

    // Review & Install step must show the Install button.
    await expect(page.getByRole('button', { name: /^install$/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /^install$/i })).toBeEnabled();
  });
});
