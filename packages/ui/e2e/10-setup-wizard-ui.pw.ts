import { test, expect, type Page } from '@playwright/test';
import { ADMIN_TOKEN } from './helpers';

async function openWizard(page: Page) {
	const overlay = page.locator('.wizard-overlay');
	if (await overlay.isVisible()) return;
	await page.locator('button', { hasText: 'Run Setup Wizard' }).click();
	await expect(overlay).toBeVisible();
}

/** Fill the required Profile step fields so the wizard can advance.
 *  Uses the known e2e admin token as the password so subsequent API calls
 *  (which send x-admin-token from the client store) stay in sync with the
 *  server's expected token.
 */
async function fillProfileStep(page: Page) {
	await page.locator('#wiz-profile-password').fill(ADMIN_TOKEN);
	await page.locator('#wiz-profile-password2').fill(ADMIN_TOKEN);
}

/** Fill the required AI Providers step field so the wizard can advance. */
async function fillProvidersStep(page: Page) {
	await page.locator('#wiz-anthropic-key').fill('sk-ant-test-key-for-e2e');
}

test.beforeEach(async ({ page }) => {
	await page.goto('/');
	await page.evaluate((token) => localStorage.setItem('op_admin', token), ADMIN_TOKEN);
	await page.reload();
});

test.describe('setup wizard browser flow', () => {
	test('setup wizard overlay is visible', async ({ page }) => {
		await expect(page.locator('h2', { hasText: 'Dashboard' })).toBeVisible();
		await openWizard(page);
		await expect(page.locator('.wizard h2')).toContainText('Welcome');
	});

	test('wizard step navigation: Welcome -> Profile -> AI Providers -> Security -> Channels', async ({
		page
	}) => {
		await openWizard(page);

		await expect(page.locator('.wizard h2')).toContainText('Welcome');
		await expect(page.locator('text=Welcome to')).toBeVisible();
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wizard h2')).toContainText('Profile');
		await expect(page.locator('#wiz-profile-name')).toBeVisible();
		await expect(page.locator('#wiz-profile-email')).toBeVisible();
		await fillProfileStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wizard h2')).toContainText('AI Providers');
		await fillProvidersStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wizard h2')).toContainText('Security');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wizard h2')).toContainText('Channels');
		await expect(page.locator('.wiz-ch').first()).toBeVisible();
	});

	test('wizard Back button navigates to previous step', async ({ page }) => {
		await openWizard(page);

		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Profile');

		await page.locator('.wizard .actions button', { hasText: 'Back' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Welcome');
	});

	test('full wizard flow reaches Complete step', async ({ page }) => {
		await openWizard(page);

		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Profile');
		await fillProfileStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('AI Providers');
		await fillProvidersStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Security');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Channels');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wizard h2')).toContainText('Access');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wizard h2')).toContainText('Health Check');
		await page.locator('.wizard .actions button', { hasText: 'Finish Setup' }).click();

		await expect(page.locator('.wizard h2')).toContainText('Complete');
		await expect(page.locator('text=Finalizing setup')).toBeVisible();
	});

	// rec2.1 — profile step rejects a password shorter than 8 characters
	test('profile step shows error for short password', async ({ page }) => {
		await openWizard(page);

		// Advance to Profile step
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Profile');

		// Fill the password with a value shorter than 8 characters
		await page.locator('#wiz-profile-password').fill('short1');
		// Leave confirm password empty
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		// Error message should appear and wizard should stay on Profile
		await expect(page.locator('.wiz-error.visible').first()).toContainText(
			'Password must be at least 8 characters.'
		);
		await expect(page.locator('.wizard h2')).toContainText('Profile');
	});

	// rec2.2 — profile step rejects mismatched passwords
	test('profile step shows error when passwords do not match', async ({ page }) => {
		await openWizard(page);

		// Advance to Profile step
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Profile');

		// Fill with two different valid-length passwords
		await page.locator('#wiz-profile-password').fill('password-alpha');
		await page.locator('#wiz-profile-password2').fill('password-beta');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		// Error message should appear and wizard should stay on Profile
		await expect(page.locator('.wiz-error.visible').first()).toContainText(
			'Passwords do not match.'
		);
		await expect(page.locator('.wizard h2')).toContainText('Profile');
	});

	// rec2.3 — AI Providers step rejects a missing Anthropic key
	test('AI Providers step shows error when Anthropic key is empty', async ({ page }) => {
		await openWizard(page);

		// Advance through Welcome → Profile
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Profile');
		await fillProfileStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wizard h2')).toContainText('AI Providers');

		// Make sure the Anthropic key field is empty (default) and click Next
		await page.locator('#wiz-anthropic-key').fill('');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		// Error banner should appear and wizard should stay on AI Providers
		await expect(page.locator('.wiz-error.visible').first()).toContainText(
			'An Anthropic API key is required.'
		);
		await expect(page.locator('.wizard h2')).toContainText('AI Providers');
	});

	// rec2.4 — setup.complete returning 500 shows an error banner and re-enables Finish Setup
	test('Finish Setup shows error and re-enables button when setup.complete returns 500', async ({
		page
	}) => {
		// Intercept only setup.complete POST requests and return a 500 error
		await page.route('**/command', async (route) => {
			const body = route.request().postDataJSON() as { type?: string } | null;
			if (body?.type === 'setup.complete') {
				await route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({ ok: false, error: 'docker compose failed' })
				});
			} else {
				await route.continue();
			}
		});

		await openWizard(page);

		// Drive the wizard through to Health Check step
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Profile');
		await fillProfileStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('AI Providers');
		await fillProvidersStep(page);
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Security');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Channels');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Access');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Health Check');

		// Click Finish Setup — setup.complete is intercepted and returns 500
		await page.locator('.wizard .actions button', { hasText: 'Finish Setup' }).click();

		// Error banner must appear (SetupWizard.svelte:236-239)
		await expect(page.locator('.wiz-error.visible').first()).toContainText('Setup failed:');

		// Finish Setup button must be re-enabled (finishInProgress reset to false in finally block)
		await expect(
			page.locator('.wizard .actions button', { hasText: 'Finish Setup' })
		).toBeEnabled();
	});
});
