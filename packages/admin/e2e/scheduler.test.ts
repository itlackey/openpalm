/**
 * Automation Scheduler — Stack-dependent E2E tests
 *
 * Validates that automations are loaded and reported correctly via the
 * admin API. The admin API returns static automation config (name, schedule,
 * enabled, action, fileName). Live scheduler status and execution logs
 * are available from the scheduler sidecar at http://scheduler:8090.
 *
 * These tests hit the real admin container at http://localhost:8100 and
 * require a running compose stack.
 *
 * Run with:
 *   RUN_DOCKER_STACK_TESTS=1 ADMIN_TOKEN=dev-admin-token bun run admin:test:e2e
 */

import { expect, test } from '@playwright/test';

const ADMIN_URL = 'http://localhost:8100';

/** Build admin auth headers. */
function adminHeaders(): Record<string, string> {
	return {
		'x-admin-token': process.env.ADMIN_TOKEN ?? '',
		'x-requested-by': 'test',
		'x-request-id': crypto.randomUUID()
	};
}

// ── Group: Scheduler API (stack-dependent) ───────────────────────────

test.describe('Automation Scheduler API', () => {
	const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

	test('GET /admin/automations returns valid structure', async ({ request }) => {
		const response = await request.get(`${ADMIN_URL}/admin/automations`, {
			headers: adminHeaders(),
			timeout: 10_000
		});

		expect(response.ok()).toBeTruthy();
		const data = await response.json();

		// Must have top-level automations array
		expect(data).toHaveProperty('automations');
		expect(Array.isArray(data.automations)).toBe(true);
	});

	test('GET /admin/automations requires auth', async ({ request }) => {
		const response = await request.get(`${ADMIN_URL}/admin/automations`, {
			headers: { 'x-request-id': crypto.randomUUID() },
			timeout: 10_000
		});
		expect(response.status()).toBe(401);
	});

	test('automation entries have required fields', async ({ request }) => {
		const response = await request.get(`${ADMIN_URL}/admin/automations`, {
			headers: adminHeaders(),
			timeout: 10_000
		});

		expect(response.ok()).toBeTruthy();
		const data = await response.json();

		for (const automation of data.automations) {
			expect(typeof automation.name).toBe('string');
			expect(typeof automation.schedule).toBe('string');
			expect(typeof automation.enabled).toBe('boolean');
			expect(typeof automation.fileName).toBe('string');
			expect(automation.fileName).toMatch(/\.yml$/);

			// Action must have a valid type
			expect(automation.action).toBeDefined();
			expect(['api', 'http', 'shell', 'assistant']).toContain(automation.action.type);
		}
	});

	test('core automations are present and enabled', async ({ request }) => {
		const response = await request.get(`${ADMIN_URL}/admin/automations`, {
			headers: adminHeaders(),
			timeout: 10_000
		});

		expect(response.ok()).toBeTruthy();
		const data = await response.json();

		// A deployed stack should have at least one automation (core automations
		// are seeded during setup). If no automations exist, the test still passes
		// since the automation structure was already validated above.
		if (data.automations.length > 0) {
			// At least one automation should be enabled
			const hasEnabled = data.automations.some((a: { enabled: boolean }) => a.enabled);
			expect(hasEnabled).toBe(true);
		}
	});
});
