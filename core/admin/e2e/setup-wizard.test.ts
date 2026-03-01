import { expect, test } from '@playwright/test';

test.describe('Setup Wizard', () => {
	test('setup page loads and shows wizard with admin token step', async ({ page }) => {
		await page.goto('/setup');
		await expect(page.locator('h1')).toHaveText('OpenPalm Setup Wizard');
		await expect(page.getByTestId('step-token')).toBeVisible();
		await expect(page.locator('h2')).toHaveText('Admin Token');
	});

	test('admin token step validates non-empty token', async ({ page }) => {
		await page.goto('/setup');
		await expect(page.getByTestId('step-token')).toBeVisible();

		// Click Next without entering token
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.locator('[role="alert"]')).toHaveText('Admin token is required.');

		// Still on step 1
		await expect(page.getByTestId('step-token')).toBeVisible();
	});

	test('wizard navigates through all 4 steps', async ({ page }) => {
		await page.goto('/setup');

		// Step 1: Admin Token
		await expect(page.getByTestId('step-token')).toBeVisible();
		await page.locator('#admin-token').fill('my-secure-token');
		await page.getByRole('button', { name: 'Next' }).click();

		// Step 2: LLM Provider
		await expect(page.getByTestId('step-llm')).toBeVisible();
		await expect(page.locator('h2')).toHaveText('LLM Provider');
		await page.locator('#openai-api-key').fill('sk-test-key-1234567890');
		await page.locator('#openai-base-url').fill('http://host.docker.internal:11434/v1');
		await page.getByRole('button', { name: 'Next' }).click();

		// Step 3: OpenMemory — user ID pre-populated from server-detected userId
		await expect(page.getByTestId('step-openmemory')).toBeVisible();
		await expect(page.locator('h2')).toHaveText('OpenMemory');
		// Server provides detected user — just verify the field has a non-empty value
		const userIdValue = await page.locator('#openmemory-user-id').inputValue();
		expect(userIdValue.length).toBeGreaterThan(0);
		await page.locator('#openmemory-user-id').fill('alice');
		await page.getByRole('button', { name: 'Next' }).click();

		// Step 4: Review — should show local values only
		await expect(page.getByTestId('step-review')).toBeVisible();
		await expect(page.locator('h2')).toHaveText('Review & Install');
		// Admin token just says "Set"
		await expect(page.getByText('Set').first()).toBeVisible();
		// API key is masked (shows last 4 chars from local input)
		await expect(page.locator('.review-value.mono').nth(1)).toContainText('7890');
		// User ID
		await expect(page.getByText('alice')).toBeVisible();
	});

	test('back button navigation works through all steps', async ({ page }) => {
		await page.goto('/setup');

		// Step 1 -> 2
		await page.locator('#admin-token').fill('token');
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.getByTestId('step-llm')).toBeVisible();

		// Step 2 -> 3
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.getByTestId('step-openmemory')).toBeVisible();

		// Step 3 -> 4
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.getByTestId('step-review')).toBeVisible();

		// Go back: 4 -> 3 -> 2 -> 1
		await page.getByRole('button', { name: 'Back' }).click();
		await expect(page.getByTestId('step-openmemory')).toBeVisible();

		await page.getByRole('button', { name: 'Back' }).click();
		await expect(page.getByTestId('step-llm')).toBeVisible();

		await page.getByRole('button', { name: 'Back' }).click();
		await expect(page.getByTestId('step-token')).toBeVisible();
	});

	test('install triggers POST and redirects to home', async ({ page }) => {
		let postDone = false;

		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'POST') {
				postDone = true;
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
			// After successful POST, the root page checks GET /admin/setup
			// and redirects back to /setup if setupComplete is false.
			// Mock the GET to reflect the completed state.
			if (route.request().method() === 'GET' && postDone) {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						setupComplete: true,
						configured: { adminToken: true, openaiApiKey: false }
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');

		// Navigate through wizard
		await page.locator('#admin-token').fill('my-token');
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.getByTestId('step-review')).toBeVisible();

		// Install
		await page.getByRole('button', { name: 'Install Stack' }).click();

		// Success triggers goto('/') — wait for navigation
		await page.waitForURL('/', { timeout: 10000 });
	});

	test('POST sends adminToken in request body', async ({ page }) => {
		let postedBody: Record<string, unknown> = {};
		let postHeaders: Record<string, string> = {};
		let postDone = false;

		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'POST') {
				postedBody = JSON.parse(route.request().postData() ?? '{}');
				postHeaders = route.request().headers();
				postDone = true;
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
			if (route.request().method() === 'GET' && postDone) {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						setupComplete: true,
						configured: { adminToken: true, openaiApiKey: true }
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');
		await page.locator('#admin-token').fill('secret-token-abc');
		await page.getByRole('button', { name: 'Next' }).click();
		await page.locator('#openai-api-key').fill('sk-test');
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Install Stack' }).click();
		await expect(page).toHaveURL('/');

		expect(postedBody.adminToken).toBe('secret-token-abc');
		expect(postedBody.openaiApiKey).toBe('sk-test');
		expect(postHeaders['x-admin-token']).toBeTruthy();
	});

	test('setup page is accessible when ADMIN_TOKEN is not set', async ({ page }) => {
		// With ADMIN_TOKEN unset, the server-side +page.server.ts allows
		// access (isSetupComplete returns false). The wizard renders.
		await page.goto('/setup');
		await expect(page.locator('h1')).toHaveText('OpenPalm Setup Wizard');
	});

	test('GET /admin/setup API returns booleans, never secret values', async ({ page }) => {
		// Directly call the API endpoint to verify the response shape
		const response = await page.request.get('/admin/setup');
		expect(response.ok()).toBeTruthy();
		const parsed = await response.json();

		// The response has 'configured' with boolean values only
		expect(parsed).toHaveProperty('configured');
		for (const val of Object.values(parsed.configured as Record<string, unknown>)) {
			expect(typeof val).toBe('boolean');
		}
		// Must not expose actual secret values
		expect(parsed).not.toHaveProperty('openaiApiKey');
		expect(parsed).not.toHaveProperty('openaiBaseUrl');
		expect(parsed).not.toHaveProperty('adminToken');
	});

	test('install error shows error message and allows retry', async ({ page }) => {
		let callCount = 0;
		let postSucceeded = false;

		await page.route('**/admin/setup', (route) => {
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
				postSucceeded = true;
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
			if (route.request().method() === 'GET' && postSucceeded) {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						setupComplete: true,
						configured: { adminToken: true, openaiApiKey: false }
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');

		// Navigate to review
		await page.locator('#admin-token').fill('token');
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();

		// First install — should fail
		await page.getByRole('button', { name: 'Install Stack' }).click();
		await expect(page.locator('[role="alert"]')).toContainText('Failed to update secrets.env');

		// Retry — should succeed and redirect
		await page.getByRole('button', { name: 'Install Stack' }).click();
		await expect(page).toHaveURL('/');
	});

	test('Docker unavailable returns error to UI', async ({ page }) => {
		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'POST') {
				return route.fulfill({
					status: 503,
					contentType: 'application/json',
					body: JSON.stringify({
						error: 'docker_unavailable',
						message: 'Docker is not available. Install or start Docker and retry.'
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');

		// Navigate to review and install
		await page.locator('#admin-token').fill('token');
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Install Stack' }).click();

		// Should show Docker error
		await expect(page.locator('[role="alert"]')).toContainText('Docker is not available');
	});

	test('Docker Compose failure returns error to UI', async ({ page }) => {
		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'POST') {
				return route.fulfill({
					status: 502,
					contentType: 'application/json',
					body: JSON.stringify({
						error: 'compose_failed',
						message: 'Docker Compose failed to start services: port 5432 already in use'
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');

		await page.locator('#admin-token').fill('token');
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Install Stack' }).click();

		await expect(page.locator('[role="alert"]')).toContainText('Docker Compose failed');
	});

	test('setup API reports setupComplete based on server state', async ({ page }) => {
		// Verify the GET /admin/setup endpoint reflects actual server state.
		// With ADMIN_TOKEN empty, setupComplete should be false.
		const response = await page.request.get('/admin/setup');
		expect(response.ok()).toBeTruthy();
		const data = await response.json();
		expect(data).toHaveProperty('setupComplete');
		expect(typeof data.setupComplete).toBe('boolean');
		// The server-side +page.server.ts uses the same check to decide
		// whether to redirect /setup → /. When setupComplete is true,
		// the SSR redirect prevents the wizard from rendering.
	});

	test('setup endpoint does not require authentication on first run', async ({ page }) => {
		// GET /admin/setup is accessible without x-admin-token
		const response = await page.request.get('/admin/setup');
		expect(response.ok()).toBeTruthy();

		// The setup wizard page renders without authentication
		await page.goto('/setup');
		await expect(page.getByTestId('step-token')).toBeVisible();
	});
});
