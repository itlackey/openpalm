import { expect, test } from '@playwright/test';

test.describe('Setup Wizard', () => {
	test('setup page loads and shows auth gate', async ({ page }) => {
		await page.goto('/setup');
		await expect(page.locator('h1')).toHaveText('OpenPalm Setup');
		await expect(page.locator('label[for="setup-admin-token"]')).toBeVisible();
		await expect(page.locator('button[type="submit"]')).toHaveText('Continue');
	});

	test('auth gate shows error for invalid token', async ({ page }) => {
		// Mock the access-scope endpoint to return 401
		await page.route('**/admin/access-scope', (route) =>
			route.fulfill({
				status: 401,
				contentType: 'application/json',
				body: JSON.stringify({ error: 'unauthorized' })
			})
		);

		await page.goto('/setup');
		await page.locator('#setup-admin-token').fill('bad-token');
		await page.locator('button[type="submit"]').click();
		await expect(page.locator('[role="alert"]')).toHaveText('Invalid admin token.');
	});

	test('wizard navigates through all 3 steps after auth', async ({ page }) => {
		// Mock auth success
		await page.route('**/admin/access-scope', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ accessScope: 'host' })
			})
		);

		// Mock GET /admin/setup — return empty config, not installed
		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						openaiApiKey: '',
						openaiBaseUrl: '',
						openmemoryUserId: 'default_user',
						installed: false
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');

		// Authenticate
		await page.locator('#setup-admin-token').fill('test-token');
		await page.locator('button[type="submit"]').click();

		// Step 1: LLM Provider
		await expect(page.getByTestId('step-llm')).toBeVisible();
		await expect(page.locator('h2')).toHaveText('LLM Provider');
		await page.locator('#openai-api-key').fill('sk-test-key-1234567890');
		await page.locator('#openai-base-url').fill('http://host.docker.internal:11434/v1');
		await page.getByRole('button', { name: 'Next' }).click();

		// Step 2: OpenMemory
		await expect(page.getByTestId('step-openmemory')).toBeVisible();
		await expect(page.locator('h2')).toHaveText('OpenMemory');
		await expect(page.locator('#openmemory-user-id')).toHaveValue('default_user');
		await page.locator('#openmemory-user-id').fill('alice');
		await page.getByRole('button', { name: 'Next' }).click();

		// Step 3: Review
		await expect(page.getByTestId('step-review')).toBeVisible();
		await expect(page.locator('h2')).toHaveText('Review & Install');
		// API key should be masked
		await expect(page.locator('.review-value.mono').first()).toContainText('7890');
		// User ID should be shown
		await expect(page.getByText('alice')).toBeVisible();
	});

	test('back button navigation works', async ({ page }) => {
		// Mock auth
		await page.route('**/admin/access-scope', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ accessScope: 'host' })
			})
		);
		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						openaiApiKey: '',
						openaiBaseUrl: '',
						openmemoryUserId: 'default_user',
						installed: false
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');
		await page.locator('#setup-admin-token').fill('test-token');
		await page.locator('button[type="submit"]').click();

		// Navigate to step 2
		await expect(page.getByTestId('step-llm')).toBeVisible();
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.getByTestId('step-openmemory')).toBeVisible();

		// Navigate to step 3
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.getByTestId('step-review')).toBeVisible();

		// Go back to step 2
		await page.getByRole('button', { name: 'Back' }).click();
		await expect(page.getByTestId('step-openmemory')).toBeVisible();

		// Go back to step 1
		await page.getByRole('button', { name: 'Back' }).click();
		await expect(page.getByTestId('step-llm')).toBeVisible();
	});

	test('install triggers POST and shows success state', async ({ page }) => {
		// Mock auth
		await page.route('**/admin/access-scope', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ accessScope: 'host' })
			})
		);

		// Mock GET and POST /admin/setup
		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						openaiApiKey: '',
						openaiBaseUrl: '',
						openmemoryUserId: 'default_user',
						installed: false
					})
				});
			}
			if (route.request().method() === 'POST') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						ok: true,
						started: ['caddy', 'postgres', 'qdrant', 'openmemory', 'admin'],
						dockerAvailable: true,
						composeResult: { ok: true, stderr: '' }
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');

		// Auth
		await page.locator('#setup-admin-token').fill('test-token');
		await page.locator('button[type="submit"]').click();

		// Navigate through wizard
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.getByTestId('step-review')).toBeVisible();

		// Click Install Stack
		await page.getByRole('button', { name: 'Install Stack' }).click();

		// Verify success state
		await expect(page.locator('h2')).toHaveText('Stack Installed');
		await expect(page.getByText('All services are up and running.')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Go to Console' })).toHaveAttribute('href', '/');
		// Check started services are displayed
		await expect(page.getByText('caddy')).toBeVisible();
		await expect(page.getByText('postgres')).toBeVisible();
	});

	test('already installed shows done state on load', async ({ page }) => {
		// Mock auth
		await page.route('**/admin/access-scope', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ accessScope: 'host' })
			})
		);

		// Mock GET /admin/setup with installed: true
		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						openaiApiKey: 'sk-existing',
						openaiBaseUrl: '',
						openmemoryUserId: 'default_user',
						installed: true
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');

		// Auth with stored token
		await page.locator('#setup-admin-token').fill('test-token');
		await page.locator('button[type="submit"]').click();

		// Should skip to done state
		await expect(page.locator('h2')).toHaveText('Stack Installed');
		await expect(page.getByRole('link', { name: 'Go to Console' })).toBeVisible();
	});

	test('install error shows error message and allows retry', async ({ page }) => {
		let callCount = 0;

		// Mock auth
		await page.route('**/admin/access-scope', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ accessScope: 'host' })
			})
		);

		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						openaiApiKey: '',
						openaiBaseUrl: '',
						openmemoryUserId: 'default_user',
						installed: false
					})
				});
			}
			if (route.request().method() === 'POST') {
				callCount++;
				if (callCount === 1) {
					return route.fulfill({
						status: 500,
						contentType: 'application/json',
						body: JSON.stringify({
							error: 'config_save_failed',
							message: 'Failed to update secrets.env: file locked'
						})
					});
				}
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						ok: true,
						started: ['admin'],
						dockerAvailable: true,
						composeResult: { ok: true, stderr: '' }
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');

		// Auth
		await page.locator('#setup-admin-token').fill('test-token');
		await page.locator('button[type="submit"]').click();

		// Navigate to review
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();

		// First install — should fail
		await page.getByRole('button', { name: 'Install Stack' }).click();
		await expect(page.locator('[role="alert"]')).toContainText('Failed to update secrets.env');

		// Retry — should succeed
		await page.getByRole('button', { name: 'Install Stack' }).click();
		await expect(page.locator('h2')).toHaveText('Stack Installed');
	});
});
