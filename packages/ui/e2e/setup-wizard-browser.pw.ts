/**
 * Setup wizard — browser walkthrough (UI flow, no voice).
 *
 * Resets stack.env, drives the wizard end-to-end in a real browser,
 * picks browser-tts/browser-stt so the deploy stays on the fast path
 * (no openpalm/voice pull), and asserts the success screen renders.
 *
 * What this covers:
 *   - Setup guard redirects unauth users to /setup after a state reset
 *   - SystemCheck → Welcome → Providers (allow-empty) → Models →
 *     Voice → Options → Review → Install → Deploy → Setup Complete
 *   - The Install button actually triggers the API; the success screen
 *     (#deploy-done) appears within the deploy window
 *
 * What it does NOT cover:
 *   - OpenPalm Voice container pull (see slow suite)
 *   - Provider OAuth flows (would need real credentials)
 *   - Host AKM import
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
const DEPLOY_DEADLINE_MS = 5 * 60_000;

const E2E_PASSWORD = 'wizard-e2e-test-password';

test.describe('Setup wizard — browser walkthrough (no voice)', () => {
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running dev stack');
	// Allow the deploy phase the full 5-min wait.
	test.setTimeout(7 * 60_000);

	test.beforeAll(() => {
		resetWizardState(resolveOpHome());
	});

	test.afterAll(() => {
		restoreWizardState(resolveOpHome());
	});

	test('walks every step and lands on Setup Complete', async ({ page }) => {
		// Setup guard should redirect / to /setup when stack.env is in the
		// pre-setup state. Land directly on /setup either way.
		await page.goto(`${ADMIN_URL}/setup`);

		// ── Step 0: System Check ─────────────────────────────────────
		await expect(page.locator('[data-testid="step-system-check"]')).toBeVisible();
		const sysCheckNext = page.locator('#btn-syscheck-next');
		// The button is enabled once docker is detected — wait up to 30s.
		await expect(sysCheckNext).toBeEnabled({ timeout: 30_000 });
		await sysCheckNext.click();

		// ── Step 1: Welcome ──────────────────────────────────────────
		await expect(page.locator('[data-testid="step-welcome"]')).toBeVisible();
		// Set the password BEFORE proceeding — the wizard validates it on
		// transition. The field id is wired up in WelcomeStep / +page.svelte.
		await page.fill('input[type="password"]', E2E_PASSWORD).catch(() => {
			// If WelcomeStep doesn't render the password field directly, the
			// next-button click will surface the validation error and we'll
			// see it in the test output.
		});
		await page.locator('#btn-step0-next').click();

		// ── Step 2: Providers (allow-empty install) ─────────────────
		await expect(page.locator('[data-testid="step-capabilities"]')).toBeVisible();
		// Check the "Install without an AI provider" toggle so we can
		// proceed without configuring real credentials.
		const allowEmpty = page.locator('#allow-empty-install');
		await allowEmpty.check();
		await page.locator('#btn-step1-next').click();

		// ── Step 3: Models ──────────────────────────────────────────
		await expect(page.locator('[data-testid="step-models"]')).toBeVisible();
		await page.locator('#btn-step2-next').click();

		// ── Step 4: Voice — pick Browser Built-in for both sides ────
		await expect(page.locator('[data-testid="step-voice"]')).toBeVisible();
		// Open the "Configure voice…" details, then click each Browser
		// Built-in card. Cards have no testid; match by visible text.
		const configureSummary = page.locator('#voice-configure-toggle');
		if (await configureSummary.isVisible()) {
			await configureSummary.click();
		}
		// First "Browser Built-in" → TTS engine card. Second → STT engine card.
		const browserCards = page.getByRole('button', { name: 'Browser Built-in' });
		await browserCards.nth(0).click();
		await browserCards.nth(1).click();
		await page.locator('#btn-step3-next').click();

		// ── Step 5: Options ─────────────────────────────────────────
		await expect(page.locator('[data-testid="step-options"]')).toBeVisible();
		await page.locator('#btn-step4-next').click();

		// ── Step 6: Review + Install ────────────────────────────────
		await expect(page.locator('[data-testid="step-review"]')).toBeVisible();
		await page.locator('#btn-install').click();

		// ── Deploy progress + success screen ────────────────────────
		// The deploy step renders once handleInstall flips showDeploy.
		// The success state shows the #deploy-done container.
		await expect(page.locator('#deploy-done')).toBeVisible({ timeout: DEPLOY_DEADLINE_MS });

		// Sanity: title says "Setup Complete".
		await expect(page.locator('#deploy-title')).toHaveText(/Setup Complete/i);
	});
});
