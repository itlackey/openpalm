import { expect, test } from '@playwright/test';

/**
 * Helper: mock the /admin/setup/models endpoint so the "Test Connection"
 * button in step 2 succeeds and populates the model list.
 */
async function mockModelsEndpoint(page: import('@playwright/test').Page) {
	await page.route('**/admin/setup/models', (route) => {
		if (route.request().method() === 'POST') {
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					models: ['llama3', 'llama3:70b', 'nomic-embed-text', 'mistral']
				})
			});
		}
		return route.continue();
	});
}

/**
 * Helper: mock the /admin/providers/local endpoint so the provider step
 * does not make real network calls for local provider detection.
 */
async function mockLocalProvidersEndpoint(page: import('@playwright/test').Page) {
	await page.route('**/admin/providers/local', (route) => {
		return route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ providers: [] })
		});
	});
}

/**
 * Helper: navigate from step 2 connection-type picker through "Test Connection"
 * so the Next button becomes enabled. Selects the cloud path with openai provider.
 */
async function completeConnectStep(page: import('@playwright/test').Page) {
	// Sub-step 2a: pick "OpenAI-Compatible (Remote)" connection type
	await page.getByRole('button', { name: /OpenAI-Compatible/ }).click();
	await page.locator('#llm-api-key').fill('sk-test');

	// Sub-step 2b: test connection (default provider is openai)
	await page.getByRole('button', { name: 'Test Connection' }).click();
	await expect(page.locator('[role="status"]')).toBeVisible({ timeout: 5000 });
}

/**
 * Helper: fill in step 1 (Welcome) fields and advance to step 2.
 */
async function completeWelcomeStep(page: import('@playwright/test').Page, opts?: { name?: string; token?: string }) {
	await page.locator('#owner-name').fill(opts?.name ?? 'Test User');
	await page.locator('#admin-token').fill(opts?.token ?? 'my-secure-token');
	await page.getByRole('button', { name: 'Next' }).click();
}

/**
 * Helper: mock the deploy-status endpoint to immediately report ready.
 */
async function mockDeployStatusReady(page: import('@playwright/test').Page) {
	await page.route('**/admin/setup/deploy-status', (route) => {
		return route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				active: true,
				phase: 'ready',
				message: 'All services are up and running.',
				services: [
					{ service: 'caddy', label: 'Caddy', imageReady: true, containerRunning: true },
					{ service: 'memory', label: 'Memory', imageReady: true, containerRunning: true },
				],
			})
		});
	});
}

test.describe('Setup Wizard', () => {
	test('setup page loads and shows wizard with welcome step', async ({ page }) => {
		await page.goto('/setup');
		await expect(page.locator('h1')).toHaveText('OpenPalm Setup Wizard');
		await expect(page.getByTestId('step-token')).toBeVisible();
		await expect(page.locator('h2')).toHaveText('Welcome');
	});

	test('welcome step validates required fields', async ({ page }) => {
		await page.goto('/setup');
		await expect(page.getByTestId('step-token')).toBeVisible();

		// Click Next without entering anything — name is required first
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.locator('[role="alert"]')).toHaveText('Name is required.');

		// Fill name but not token
		await page.locator('#owner-name').fill('Test User');
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.locator('[role="alert"]')).toHaveText('Admin token is required.');

		// Still on step 1
		await expect(page.getByTestId('step-token')).toBeVisible();
	});

	test('wizard navigates through all 4 steps', async ({ page }) => {
		await mockModelsEndpoint(page);
		await mockLocalProvidersEndpoint(page);
		await page.goto('/setup');

		// Step 1: Welcome
		await expect(page.getByTestId('step-token')).toBeVisible();
		await completeWelcomeStep(page);

		// Step 2: Connection
		await expect(page.getByTestId('step-provider')).toBeVisible();
		await expect(page.locator('h2')).toHaveText('Connection Type');
		await completeConnectStep(page);
		await page.getByRole('button', { name: 'Next' }).click();

		// Step 3: Select Models
		await expect(page.getByTestId('step-models')).toBeVisible();
		await expect(page.locator('h2')).toHaveText('Select Models');
		// Verify model selects are populated
		await expect(page.locator('#system-model')).toBeVisible();
		await expect(page.locator('#embedding-model')).toBeVisible();
		// Memory user ID is pre-populated from server-detected userId
		const userIdValue = await page.locator('#memory-user-id').inputValue();
		expect(userIdValue.length).toBeGreaterThan(0);
		await page.locator('#memory-user-id').fill('alice');
		await page.getByRole('button', { name: 'Next' }).click();

		// Step 4: Review & Install
		await expect(page.getByTestId('step-review')).toBeVisible();
		await expect(page.locator('h2')).toHaveText('Review & Install');
		// Admin token just says "Set"
		await expect(page.getByText('Set').first()).toBeVisible();
		// Provider shows label (e.g., "Cloud — OpenAI")
		await expect(page.getByText('Cloud — OpenAI')).toBeVisible();
		// User ID
		await expect(page.getByText('alice')).toBeVisible();
	});

	test('back button navigation works through all steps', async ({ page }) => {
		await mockModelsEndpoint(page);
		await mockLocalProvidersEndpoint(page);
		await page.goto('/setup');

		// Step 1 -> 2
		await completeWelcomeStep(page);
		await expect(page.getByTestId('step-provider')).toBeVisible();

		// Test connection so Next is enabled
		await completeConnectStep(page);

		// Step 2 -> 3
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.getByTestId('step-models')).toBeVisible();

		// Step 3 -> 4
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.getByTestId('step-review')).toBeVisible();

		// Go back: 4 -> 3 -> 2b (cloud details) -> 2a (connection type) -> 1
		await page.getByRole('button', { name: 'Back' }).click();
		await expect(page.getByTestId('step-models')).toBeVisible();

		await page.getByRole('button', { name: 'Back' }).click();
		await expect(page.getByTestId('step-provider')).toBeVisible();
		// Now on cloud sub-step; Back goes to connection-type picker
		await page.getByRole('button', { name: 'Back' }).click();
		await expect(page.locator('h2')).toHaveText('Connection Type');
		// Back from connection-type picker goes to step 1
		await page.getByRole('button', { name: 'Back' }).click();
		await expect(page.getByTestId('step-token')).toBeVisible();
	});

	test('install triggers POST and shows deploying screen', async ({ page }) => {
		await mockModelsEndpoint(page);
		await mockLocalProvidersEndpoint(page);
		await mockDeployStatusReady(page);

		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'POST') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						ok: true,
						async: true,
						started: ['caddy', 'memory', 'admin'],
						dockerAvailable: true,
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');

		// Navigate through wizard
		await completeWelcomeStep(page, { token: 'my-token' });
		await completeConnectStep(page);
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.getByTestId('step-review')).toBeVisible();

		// Install
		await page.getByRole('button', { name: 'Install Stack' }).click();

		// Should transition to deploying screen
		await expect(page.getByTestId('step-deploying')).toBeVisible({ timeout: 5000 });

		// Deploy status mock returns ready, so "Go to Console" should appear
		await expect(page.getByRole('link', { name: 'Go to Console' })).toBeVisible({ timeout: 10000 });
	});

	test('POST sends correct fields in request body', async ({ page }) => {
		let postedBody: Record<string, unknown> = {};
		let postHeaders: Record<string, string> = {};

		await mockModelsEndpoint(page);
		await mockLocalProvidersEndpoint(page);
		await mockDeployStatusReady(page);

		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'POST') {
				postedBody = JSON.parse(route.request().postData() ?? '{}');
				postHeaders = route.request().headers();
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						ok: true,
						async: true,
						started: ['admin'],
						dockerAvailable: true,
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');

		// Step 1: Welcome
		await completeWelcomeStep(page, { name: 'Alice', token: 'secret-token-abc' });

		// Step 2: Connection — select cloud, fill API key, test connection
		await page.getByRole('button', { name: /OpenAI-Compatible/ }).click();
		await page.locator('#llm-api-key').fill('sk-test');
		await page.getByRole('button', { name: 'Test Connection' }).click();
		await expect(page.locator('[role="status"]')).toBeVisible({ timeout: 5000 });
		await page.getByRole('button', { name: 'Next' }).click();

		// Step 3: Models → Step 4: Review
		await page.getByRole('button', { name: 'Next' }).click();

		// Install
		await page.getByRole('button', { name: 'Install Stack' }).click();

		// Wait for deploying screen to appear (confirms POST was made)
		await expect(page.getByTestId('step-deploying')).toBeVisible({ timeout: 5000 });

		expect(postedBody.adminToken).toBe('secret-token-abc');
		expect(postedBody.ownerName).toBe('Alice');
		expect(postedBody.llmApiKey).toBe('sk-test');
		expect(postedBody.llmProvider).toBe('openai');
		expect(postedBody.systemModel).toBeTruthy();
		expect(postedBody.embeddingModel).toBeTruthy();
		expect(postedBody.embeddingDims).toBeTruthy();
		expect(postedBody.memoryUserId).toBeTruthy();
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

		await mockModelsEndpoint(page);
		await mockLocalProvidersEndpoint(page);
		await mockDeployStatusReady(page);

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
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						ok: true,
						async: true,
						started: ['admin'],
						dockerAvailable: true,
					})
				});
			}
			return route.continue();
		});

		await page.goto('/setup');

		// Navigate to review
		await completeWelcomeStep(page);
		await completeConnectStep(page);
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();

		// First install — should fail and stay on review screen
		await page.getByRole('button', { name: 'Install Stack' }).click();
		await expect(page.locator('[role="alert"]')).toContainText('Failed to update secrets.env');

		// Retry — should succeed and show deploying screen
		await page.getByRole('button', { name: 'Install Stack' }).click();
		await expect(page.getByTestId('step-deploying')).toBeVisible({ timeout: 5000 });
	});

	test('Docker unavailable returns error to UI', async ({ page }) => {
		await mockModelsEndpoint(page);
		await mockLocalProvidersEndpoint(page);

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
		await completeWelcomeStep(page);
		await completeConnectStep(page);
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Install Stack' }).click();

		// Should show Docker error on review screen (pre-deploy error)
		await expect(page.locator('[role="alert"]')).toContainText('Docker is not available');
	});

	test('Docker Compose failure surfaces on deploying screen', async ({ page }) => {
		await mockModelsEndpoint(page);
		await mockLocalProvidersEndpoint(page);

		// POST succeeds (async deploy starts)
		await page.route('**/admin/setup', (route) => {
			if (route.request().method() === 'POST') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						ok: true,
						async: true,
						started: ['caddy', 'memory'],
						dockerAvailable: true,
					})
				});
			}
			return route.continue();
		});

		// Deploy status reports compose error
		await page.route('**/admin/setup/deploy-status', (route) => {
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					active: true,
					phase: 'error',
					message: 'Docker Compose failed: port 5432 already in use',
					error: 'Docker Compose failed: port 5432 already in use',
					services: [
						{ service: 'caddy', label: 'Caddy', imageReady: true, containerRunning: false },
						{ service: 'memory', label: 'Memory', imageReady: true, containerRunning: false },
					],
				})
			});
		});

		await page.goto('/setup');

		await completeWelcomeStep(page);
		await completeConnectStep(page);
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByRole('button', { name: 'Install Stack' }).click();

		// Should show deploying screen with error
		await expect(page.getByTestId('step-deploying')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('[role="alert"]')).toContainText('Docker Compose failed');
	});

	test('setup API reports setupComplete based on server state', async ({ page }) => {
		// Verify the GET /admin/setup endpoint reflects actual server state.
		// With OPENPALM_SETUP_COMPLETE=false, setupComplete should be false.
		const response = await page.request.get('/admin/setup');
		expect(response.ok()).toBeTruthy();
		const data = await response.json();
		expect(data).toHaveProperty('setupComplete');
		expect(typeof data.setupComplete).toBe('boolean');
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
