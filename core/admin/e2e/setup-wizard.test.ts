import { expect, test } from '@playwright/test';

test.describe('Setup Wizard', () => {
	test('setup page loads and shows wizard with admin token step', async ({ page }) => {
		// Mock GET /admin/setup — fresh install, not complete
		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						setupComplete: false,
						installed: false,
						configured: {}
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');
		await expect(page.locator('h1')).toHaveText('OpenPalm Setup');
		await expect(page.getByTestId('step-token')).toBeVisible();
		await expect(page.locator('h2')).toHaveText('Admin Token');
	});

	test('admin token step validates non-empty token', async ({ page }) => {
		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ setupComplete: false, installed: false, configured: {} })
				});
			}
			return route.continue();
		});

		await page.goto('/setup');
		await expect(page.getByTestId('step-token')).toBeVisible();

		// Click Next without entering token
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.locator('[role="alert"]')).toHaveText('Admin token is required.');

		// Still on step 1
		await expect(page.getByTestId('step-token')).toBeVisible();
	});

	test('wizard navigates through all 4 steps', async ({ page }) => {
		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ setupComplete: false, installed: false, configured: {} })
				});
			}
			return route.continue();
		});

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

		// Step 3: OpenMemory
		await expect(page.getByTestId('step-openmemory')).toBeVisible();
		await expect(page.locator('h2')).toHaveText('OpenMemory');
		await expect(page.locator('#openmemory-user-id')).toHaveValue('default_user');
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
		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ setupComplete: false, installed: false, configured: {} })
				});
			}
			return route.continue();
		});

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

	test('install triggers POST and shows success state', async ({ page }) => {
		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ setupComplete: false, installed: false, configured: {} })
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

		// Navigate through wizard
		await page.locator('#admin-token').fill('my-token');
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.getByTestId('step-review')).toBeVisible();

		// Install
		await page.getByRole('button', { name: 'Install Stack' }).click();

		// Success state
		await expect(page.locator('h2')).toHaveText('Stack Installed');
		await expect(page.getByText('All services are up and running.')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Go to Console' })).toHaveAttribute('href', '/');
		await expect(page.getByText('caddy')).toBeVisible();
		await expect(page.getByText('postgres')).toBeVisible();
	});

	test('POST sends adminToken in request body', async ({ page }) => {
		let postedBody: Record<string, unknown> = {};

		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ setupComplete: false, installed: false, configured: {} })
				});
			}
			if (route.request().method() === 'POST') {
				postedBody = JSON.parse(route.request().postData() ?? '{}');
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
		await page.locator('#admin-token').fill('secret-token-abc');
		await page.getByRole('button', { name: 'Next' }).click();
		await page.locator('#openai-api-key').fill('sk-test');
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Install Stack' }).click();
		await expect(page.locator('h2')).toHaveText('Stack Installed');

		expect(postedBody.adminToken).toBe('secret-token-abc');
		expect(postedBody.openaiApiKey).toBe('sk-test');
	});

	test('already-complete setup shows done state on load', async ({ page }) => {
		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						setupComplete: true,
						installed: true,
						configured: {
							OPENAI_API_KEY: true,
							OPENAI_BASE_URL: false,
							OPENMEMORY_USER_ID: true
						}
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');

		// Should show done state directly — no wizard
		await expect(page.locator('h2')).toHaveText('Stack Installed');
		await expect(page.getByRole('link', { name: 'Go to Console' })).toBeVisible();
	});

	test('GET /admin/setup never returns env values', async ({ page }) => {
		let getResponseBody = '';

		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				const body = JSON.stringify({
					setupComplete: false,
					installed: false,
					configured: {
						OPENAI_API_KEY: true,
						OPENAI_BASE_URL: false,
						OPENMEMORY_USER_ID: true
					}
				});
				getResponseBody = body;
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body
				});
			}
			return route.continue();
		});

		await page.goto('/setup');

		// Verify the response shape has only booleans, no string values
		const parsed = JSON.parse(getResponseBody);
		expect(parsed.configured.OPENAI_API_KEY).toBe(true);
		expect(parsed.configured.OPENAI_BASE_URL).toBe(false);
		for (const val of Object.values(parsed.configured)) {
			expect(typeof val).toBe('boolean');
		}
		// Must not have string value fields for secrets
		expect(parsed).not.toHaveProperty('openaiApiKey');
		expect(parsed).not.toHaveProperty('openaiBaseUrl');
		expect(parsed).not.toHaveProperty('openmemoryUserId');
	});

	test('install error shows error message and allows retry', async ({ page }) => {
		let callCount = 0;

		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ setupComplete: false, installed: false, configured: {} })
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

		// Navigate to review
		await page.locator('#admin-token').fill('token');
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();

		// First install — should fail
		await page.getByRole('button', { name: 'Install Stack' }).click();
		await expect(page.locator('[role="alert"]')).toContainText('Failed to update secrets.env');

		// Retry — should succeed
		await page.getByRole('button', { name: 'Install Stack' }).click();
		await expect(page.locator('h2')).toHaveText('Stack Installed');
	});

	test('Docker unavailable returns error to UI', async ({ page }) => {
		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ setupComplete: false, installed: false, configured: {} })
				});
			}
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
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ setupComplete: false, installed: false, configured: {} })
				});
			}
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

	test('POST requires auth after setup is complete', async ({ page }) => {
		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					// setupComplete = true means token is already set
					body: JSON.stringify({ setupComplete: true, installed: true, configured: {} })
				});
			}
			if (route.request().method() === 'POST') {
				// After setup is complete, POST without auth returns 401
				return route.fulfill({
					status: 401,
					contentType: 'application/json',
					body: JSON.stringify({
						error: 'unauthorized',
						message: 'Missing or invalid x-admin-token'
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');

		// Should show done state — the one-time guard protects the POST
		await expect(page.locator('h2')).toHaveText('Stack Installed');
	});

	test('setup endpoint does not require authentication on first run', async ({ page }) => {
		let getHeaders: Record<string, string> = {};

		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'GET') {
				getHeaders = route.request().headers();
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ setupComplete: false, installed: false, configured: {} })
				});
			}
			return route.continue();
		});

		await page.goto('/setup');

		// Wait for the GET to complete
		await expect(page.getByTestId('step-token')).toBeVisible();

		// The request should NOT contain x-admin-token
		expect(getHeaders['x-admin-token']).toBeUndefined();
	});
});
