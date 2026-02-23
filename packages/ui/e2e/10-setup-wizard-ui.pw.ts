import { test, expect, type Page } from '@playwright/test';
import { ADMIN_TOKEN } from './helpers';

async function openWizard(page: Page) {
	const overlay = page.locator('.wizard-overlay');
	if (await overlay.isVisible()) return;
	await page.locator('button', { hasText: 'Run Setup Wizard' }).click();
	await expect(overlay).toBeVisible();
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
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wizard h2')).toContainText('AI Providers');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		await expect(page.locator('.wizard h2')).toContainText('Security');
		await expect(page.locator('#wiz-admin')).toBeVisible();
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
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('AI Providers');
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
});
