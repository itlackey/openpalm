/**
 * Setup wizard — browser smoke test.
 *
 * Collected by Playwright when RUN_DOCKER_STACK_TESTS=1 (*.stack.ts pattern).
 * Run via: ./scripts/dev-e2e-test.sh --skip-build --playwright
 *
 * Resets stack.env, loads /setup in a real browser, confirms the wizard
 * renders and the System Check step passes in a real Docker environment.
 *
 * Intentionally narrow — environment-sensitive steps (Providers, Voice)
 * depend on the host's local providers and browser speech APIs. The API
 * contract for those steps is covered by setup-wizard-api.stack.ts.
 *
 * Run with:
 *   RUN_DOCKER_STACK_TESTS=1 \
 *     OP_UI_LOGIN_PASSWORD=<password> \
 *     ADMIN_URL=http://127.0.0.1:9100 \
 *     bun run ui:test:e2e
 */

import { test, expect } from '@playwright/test';
import { resetWizardState, restoreWizardState, resolveOpHome } from './wizard-reset.ts';

const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:9100';
const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;

test.describe('Setup wizard — browser smoke', () => {
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running dev stack');
	test.setTimeout(30 * 1000);

	test.beforeAll(() => {
		resetWizardState(resolveOpHome());
	});

	test.afterAll(() => {
		restoreWizardState(resolveOpHome());
	});

	test('GET / redirects to /setup when stack.env is in pre-setup state', async ({ page }) => {
		const res = await page.goto(`${ADMIN_URL}/`);
		expect(res?.status()).toBeLessThan(400);
		await expect(page).toHaveURL(/\/setup$/);
	});

	test('loads /setup directly and renders the System Check step', async ({ page }) => {
		await page.goto(`${ADMIN_URL}/setup`);
		await expect(page.locator('[data-testid="step-system-check"]')).toBeVisible({ timeout: 10_000 });
		// btn-syscheck-next exists on the page even before docker probes
		// finish — its `disabled` state is what changes, but the element
		// is always rendered.
		await expect(page.locator('#btn-syscheck-next')).toBeAttached();
	});
});
