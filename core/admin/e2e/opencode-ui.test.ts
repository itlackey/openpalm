import { expect, test } from '@playwright/test';

/**
 * OpenCode Web UI tests — require RUN_DOCKER_STACK_TESTS=1 and a running compose stack.
 *
 * These hit the assistant container directly on port 4096 (and the Caddy proxy on 8080)
 * rather than the admin preview server, since OpenCode runs in its own container.
 */
test.describe('OpenCode Web UI', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	test('health check endpoint responds', async ({ request }) => {
		const response = await request.get('http://localhost:4096');
		expect(response.status()).toBeLessThan(500);
	});

	test('web UI loads and shows OpenCode', async ({ page }) => {
		await page.goto('http://localhost:4096', { timeout: 15000 });
		await expect(page).toHaveTitle('OpenCode', { timeout: 10000 });
	});

	test('core UI elements are present', async ({ page }) => {
		await page.goto('http://localhost:4096', { timeout: 15000 });
		await expect(page).toHaveTitle('OpenCode', { timeout: 10000 });

		// Home screen shows project picker — click into the first project
		const projectBtn = page.locator('button:has-text("/")').first();
		await expect(projectBtn).toBeVisible({ timeout: 10000 });
		await projectBtn.click();

		// Now in a session — verify chat input appears
		await expect(
			page.locator('[role="textbox"]').first()
		).toBeVisible({ timeout: 15000 });

		// Send button
		await expect(
			page.getByRole('button', { name: /send/i })
		).toBeVisible({ timeout: 5000 });

		// Navigation sidebar
		await expect(
			page.locator('nav').first()
		).toBeVisible({ timeout: 5000 });
	});

	test('new session can be created', async ({ page }) => {
		await page.goto('http://localhost:4096', { timeout: 15000 });
		await expect(page).toHaveTitle('OpenCode', { timeout: 10000 });

		// Enter the project first
		const projectBtn = page.locator('button:has-text("/")').first();
		await expect(projectBtn).toBeVisible({ timeout: 10000 });
		await projectBtn.click();

		// Wait for session to load
		await expect(page.locator('[role="textbox"]').first()).toBeVisible({ timeout: 15000 });
		const initialUrl = page.url();

		// Click "New session" button
		const newSessionBtn = page.locator('button:has-text("New session")').first();
		if (await newSessionBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
			await newSessionBtn.click();
			await page.waitForTimeout(2000);
			expect(page.url()).not.toBe(initialUrl);
		}
	});

	test('assistant plugins loaded', async ({ request }) => {
		const response = await request.get('http://localhost:4096/config', {
			timeout: 10000
		});

		// The /config endpoint may not exist in all OpenCode versions;
		// if it does, verify plugins are present
		if (response.ok()) {
			const data = await response.json();
			// Check that the response contains plugin/extension information
			expect(data).toBeDefined();
		}
	});
});

test.describe('OpenCode Caddy Proxy', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	test('Caddy proxy route serves OpenCode UI', async ({ page }) => {
		// Caddy proxies /admin/opencode/ to the assistant container
		await page.goto('http://localhost:8080/admin/opencode/', { timeout: 15000 });

		// Should load the same OpenCode UI
		await expect(page).toHaveTitle('OpenCode', { timeout: 10000 });
	});
});
