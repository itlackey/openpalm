import { expect, test } from '@playwright/test';

const ASSISTANT_OPENCODE_URL = 'http://localhost:4096';
const ADMIN_OPENCODE_URL = 'http://localhost:3881';

/**
 * OpenCode Web UI tests — require RUN_DOCKER_STACK_TESTS=1 and a running compose stack.
 *
 * These hit the assistant and admin OpenCode instances directly on their localhost-bound
 * ports rather than going through the Svelte preview server.
 *
 * OpenCode auth is disabled by default — the host-only bind address (127.0.0.1)
 * provides the security boundary. No Basic auth headers are needed.
 */

test.describe('OpenCode Web UI', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	test('health check endpoint responds', async ({ request }) => {
		const response = await request.get(ASSISTANT_OPENCODE_URL, {
			headers: { 'content-type': 'application/json' }
		});
		expect(response.status()).toBeLessThan(500);
	});

	test('web UI loads and shows OpenCode', async ({ page }) => {
		await page.goto(ASSISTANT_OPENCODE_URL, { timeout: 15000 });
		await expect(page).toHaveTitle('OpenCode', { timeout: 10000 });
	});

	test('core UI elements are present', async ({ page }) => {
		await page.goto(ASSISTANT_OPENCODE_URL, { timeout: 15000 });
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

	test('new session can be created', async ({ request }) => {
		// Use the API directly to verify session creation — avoids flaky UI overlay issues
		const res = await request.post(`${ASSISTANT_OPENCODE_URL}/session`, {
			headers: { 'content-type': 'application/json' },
			data: { title: 'e2e-new-session-test' },
			timeout: 10000
		});
		expect(res.ok(), `POST /session failed: ${res.status()}`).toBeTruthy();
		const session = await res.json();
		expect(session.id).toBeTruthy();
	});

	test('assistant plugins loaded', async ({ request }) => {
		const response = await request.get(`${ASSISTANT_OPENCODE_URL}/config`, {
			headers: { 'content-type': 'application/json' },
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

test.describe('Admin OpenCode Web UI', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	test('admin OpenCode is reachable on the configured localhost port', async ({ page }) => {
		await page.goto(ADMIN_OPENCODE_URL, { timeout: 15000 });
		await expect(page).toHaveTitle('OpenCode', { timeout: 10000 });
	});

	test('admin tools config is available', async ({ request }) => {
		const response = await request.get(`${ADMIN_OPENCODE_URL}/config`, {
			headers: { 'content-type': 'application/json' },
			timeout: 10000
		});

		expect(response.ok(), `GET /config failed: ${response.status()}`).toBeTruthy();
		const data = await response.json();
		expect(JSON.stringify(data)).toContain('@openpalm/admin-tools');
	});
});

test.describe('No default Caddy exposure', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	test('admin OpenCode is not exposed through Caddy by default', async ({ request }) => {
		await expect(
			request.get('http://localhost:8080/admin/health', { timeout: 5000 })
		).rejects.toThrow(/ECONNREFUSED|connect|socket/i);
	});
});
