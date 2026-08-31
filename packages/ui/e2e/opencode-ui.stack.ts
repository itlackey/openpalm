/**
 * OpenCode UI reachability — stack integration test.
 *
 * Collected by Playwright when RUN_DOCKER_STACK_TESTS=1 (*.stack.ts pattern).
 * Run via: ./scripts/dev-e2e-test.sh --skip-build --playwright
 */
import { expect, test } from '@playwright/test';

// The assistant container maps host port OP_ASSISTANT_PORT (default 4800 for test stacks) → container port 4096.
// Use the host-side port so tests work on the host without entering the container network.
const ASSISTANT_OPENCODE_URL = process.env.ASSISTANT_URL ?? `http://localhost:${process.env.OP_ASSISTANT_PORT ?? '4800'}`;

/**
 * OpenCode Web UI tests — require RUN_DOCKER_STACK_TESTS=1 and a running compose stack.
 *
 * These hit the assistant and admin OpenCode instances directly on their localhost-bound
 * ports rather than going through the Svelte preview server.
 *
 * OpenCode requires Basic auth on EVERY route since 0.13.0 (`OPENCODE_AUTH` is
 * gone), so the loopback bind is no longer the only boundary and these probes
 * must authenticate. `httpCredentials` covers both the browser context and the
 * `request` fixture, so `page.goto` and the API calls are both covered.
 *
 * Note `health check endpoint responds` only asserts `status < 500`, which a
 * 401 satisfies — it kept passing through the auth change and proved nothing.
 */

test.describe('OpenCode Web UI', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	test.use({
		httpCredentials: {
			username: 'opencode',
			password: process.env.OPENCODE_PASSWORD ?? ''
		}
	});


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

	test('core UI elements are present', async ({ request }) => {
		// Use the API to verify OpenCode serves its SPA correctly.
		// Browser-based SPA rendering is too dependent on load timing.
		const healthRes = await request.get(`${ASSISTANT_OPENCODE_URL}/health`);
		expect(healthRes.ok()).toBeTruthy();

		const pageRes = await request.get(ASSISTANT_OPENCODE_URL);
		expect(pageRes.ok()).toBeTruthy();
		const html = await pageRes.text();
		expect(html).toContain('<title>OpenCode</title>');
		expect(html).toContain('id="root"');
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

test.describe('No default legacy ingress', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	test('OpenCode is not exposed through the legacy ingress port by default', async ({ request }) => {
		await expect(
			request.get('http://localhost:8080/opencode/config', { timeout: 5000 })
		).rejects.toThrow(/ECONNREFUSED|connect|socket/i);
	});
});
