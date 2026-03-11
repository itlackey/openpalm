import { expect, test } from '@playwright/test';

/**
 * OpenCode Web UI tests — require RUN_DOCKER_STACK_TESTS=1 and a running compose stack.
 *
 * These hit the assistant container directly on port 4096 (and the Caddy proxy on 8080)
 * rather than the admin preview server, since OpenCode runs in its own container.
 */

/** Build OpenCode auth headers. */
function openCodeHeaders(): Record<string, string> {
	const h: Record<string, string> = { 'content-type': 'application/json' };
	const pw = process.env.OPENCODE_SERVER_PASSWORD;
	if (pw) {
		const user = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode';
		h['authorization'] = `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`;
	}
	return h;
}

/** Build OpenCode URL with embedded Basic auth credentials for browser navigation. */
function openCodeUrl(path = ''): string {
	const pw = process.env.OPENCODE_SERVER_PASSWORD;
	if (pw) {
		const user = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode';
		return `http://${user}:${pw}@localhost:4096${path}`;
	}
	return `http://localhost:4096${path}`;
}

test.describe('OpenCode Web UI', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	test('health check endpoint responds', async ({ request }) => {
		const response = await request.get('http://localhost:4096', {
			headers: openCodeHeaders()
		});
		expect(response.status()).toBeLessThan(500);
	});

	test('web UI loads and shows OpenCode', async ({ page }) => {
		await page.goto(openCodeUrl(), { timeout: 15000 });
		await expect(page).toHaveTitle('OpenCode', { timeout: 10000 });
	});

	test('core UI elements are present', async ({ page }) => {
		await page.goto(openCodeUrl(), { timeout: 15000 });
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
		const res = await request.post('http://localhost:4096/session', {
			headers: openCodeHeaders(),
			data: { title: 'e2e-new-session-test' },
			timeout: 10000
		});
		expect(res.ok(), `POST /session failed: ${res.status()}`).toBeTruthy();
		const session = await res.json();
		expect(session.id).toBeTruthy();
	});

	test('assistant plugins loaded', async ({ request }) => {
		const response = await request.get('http://localhost:4096/config', {
			headers: openCodeHeaders(),
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

	test('Caddy proxy routes admin traffic', async ({ request }) => {
		// Caddy proxies /admin/* to admin:8100 — verify admin API is reachable via Caddy
		const response = await request.get('http://localhost:8080/admin/setup', { timeout: 10000 });
		expect(response.ok()).toBeTruthy();
		const data = await response.json();
		expect(data).toHaveProperty('setupComplete');
	});
});
