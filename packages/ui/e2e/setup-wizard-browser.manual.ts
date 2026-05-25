/**
 * Setup wizard — MANUAL browser smoke (NOT an automated test).
 *
 * Renamed to `.manual.ts` so Playwright's default `testMatch: '*.pw.ts'`
 * skips it. Run only against a live dev stack — see e2e/README.md.
 *
 * Resets stack.env, loads /setup in a real browser, and confirms the
 * setup guard renders the wizard (System Check step appears).
 *
 * Why so narrow? The full UI walkthrough is environment-sensitive —
 * the Providers step's button-disabled state depends on what local
 * providers (Ollama / LMStudio / OpenAI auth.json) the host happens
 * to have, the Voice step's available choices depend on whether
 * SpeechRecognition is in the browser, etc. Driving every click
 * reliably across environments requires either heavy mocking (which
 * defeats the e2e purpose) or per-step data-testids the source
 * doesn't expose yet. Until those land, the API walkthrough in
 * setup-wizard-api.pw.ts covers the contract end-to-end; this file
 * just proves the wizard loads.
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
