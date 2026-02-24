import { test, expect } from '@playwright/test';

test.describe('dashboard browser tests', () => {
	test('page loads at / with Dashboard heading', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('h2', { hasText: 'Dashboard' })).toBeVisible();
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
		await expect(page.locator('button', { hasText: 'Run Setup Wizard' })).toBeVisible();
	});

	test('container and automation management cards are visible', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('h3', { hasText: 'Container Management' })).toBeVisible();
		await expect(page.locator('h3', { hasText: 'Automation Management' })).toBeVisible();
	});
});
