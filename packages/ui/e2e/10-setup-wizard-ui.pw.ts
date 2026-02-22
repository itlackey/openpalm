import { test, expect } from '@playwright/test';
import { ADMIN_TOKEN } from './helpers';

/**
 * Setup wizard browser tests.
 * Opens the wizard via the "Run Setup Wizard" button (works regardless of setup state).
 * Sets admin token in localStorage so API calls from the wizard succeed.
 */

test.beforeEach(async ({ page }) => {
	// Set the admin token in localStorage before navigating
	await page.goto('/admin/');
	await page.evaluate(
		(token) => localStorage.setItem('op_admin', token),
		ADMIN_TOKEN
	);
});

test.describe('setup wizard browser flow', () => {
	test('clicking "Run Setup Wizard" opens the wizard overlay', async ({ page }) => {
		await page.goto('/admin/');
		await expect(page.locator('h2')).toContainText('Dashboard');

		await page.locator('button', { hasText: 'Run Setup Wizard' }).click();
		await expect(page.locator('.wizard-overlay')).toBeVisible();
		await expect(page.locator('.wizard h2')).toContainText('Welcome');
	});

	test('wizard step navigation: Welcome -> AI Providers -> Security -> Channels', async ({
		page
	}) => {
		await page.goto('/admin/');
		await page.locator('button', { hasText: 'Run Setup Wizard' }).click();
		await expect(page.locator('.wizard-overlay')).toBeVisible();

		// Welcome step
		await expect(page.locator('.wizard h2')).toContainText('Welcome');
		await expect(page.locator('text=Welcome to')).toBeVisible();
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		// AI Providers step
		await expect(page.locator('.wizard h2')).toContainText('AI Providers');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		// Security step
		await expect(page.locator('.wizard h2')).toContainText('Security');
		await expect(page.locator('#wiz-admin')).toBeVisible();
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		// Channels step has checkboxes
		await expect(page.locator('.wizard h2')).toContainText('Channels');
		await expect(page.locator('.wiz-ch').first()).toBeVisible();
	});

	test('wizard Back button navigates to previous step', async ({ page }) => {
		await page.goto('/admin/');
		await page.locator('button', { hasText: 'Run Setup Wizard' }).click();

		// Welcome -> Next
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		await expect(page.locator('.wizard h2')).toContainText('AI Providers');

		// Back
		await page.locator('.wizard .actions button', { hasText: 'Back' }).click();
		await expect(page.locator('.wizard h2')).toContainText('Welcome');
	});

	test('full wizard flow reaches Complete step', async ({ page }) => {
		await page.goto('/admin/');
		await page.locator('button', { hasText: 'Run Setup Wizard' }).click();
		await expect(page.locator('.wizard-overlay')).toBeVisible();

		// Welcome -> Next
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		// AI Providers -> Next
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		// Security -> Next
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
		// Channels -> Next
		await expect(page.locator('.wizard h2')).toContainText('Channels');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		// Access step -> Next
		await expect(page.locator('.wizard h2')).toContainText('Access');
		await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

		// Health Check step -> Finish Setup (last content step)
		await expect(page.locator('.wizard h2')).toContainText('Health Check');
		await page.locator('.wizard .actions button', { hasText: 'Finish Setup' }).click();

		// Complete step reached — shows "Finalizing setup" text
		await expect(page.locator('.wizard h2')).toContainText('Complete');
		await expect(page.locator('text=Finalizing setup')).toBeVisible();
	});
});
