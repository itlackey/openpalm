import { test, expect } from '@playwright/test';

test.describe('dashboard browser tests', () => {
	test('page loads at / with Dashboard heading', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('h2')).toContainText('Dashboard');
	});

	test('nav bar shows OpenPalm branding, dashboard button, and theme toggle', async ({
		page
	}) => {
		await page.goto('/');
		await expect(page.locator('nav .logo')).toContainText('OpenPalm');
		await expect(page.locator('nav .nav-btn')).toContainText('Dashboard');
		await expect(page.locator('nav .theme-toggle')).toBeVisible();
	});

	test('QuickLinks card shows Open OpenCode and Open Memory Dashboard links', async ({
		page
	}) => {
		await page.goto('/');
		await expect(page.locator('text=Open OpenCode')).toBeVisible();
		await expect(page.locator('text=Open Memory Dashboard')).toBeVisible();
	});

	test('Admin Password card with input and Save button', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('text=Admin Password').first()).toBeVisible();
		await expect(page.locator('.card input[type="password"]')).toBeVisible();
	});

	test('Setup Wizard "Run Setup Wizard" button visible', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('text=Run Setup Wizard')).toBeVisible();
	});
});
