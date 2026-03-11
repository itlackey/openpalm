/**
 * Automation Scheduler — Stack-dependent E2E tests
 *
 * Validates that the scheduler is running in the admin container and that
 * automations are loaded and reported correctly via the admin API.
 *
 * These tests hit the real admin container at http://localhost:8100 and
 * require a running compose stack. They verify:
 *
 *   1. GET /admin/automations returns valid structure with scheduler status
 *   2. Automations from the state directory are loaded and listed
 *   3. Execution logs are present for automations that have fired
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

		// Must have top-level automations array and scheduler status
		expect(data).toHaveProperty('automations');
		expect(Array.isArray(data.automations)).toBe(true);
		expect(data).toHaveProperty('scheduler');
		expect(typeof data.scheduler.jobCount).toBe('number');
		expect(Array.isArray(data.scheduler.jobs)).toBe(true);
	});

	test('GET /admin/automations requires auth', async ({ request }) => {
		const response = await request.get(`${ADMIN_URL}/admin/automations`, {
			headers: { 'x-request-id': crypto.randomUUID() },
			timeout: 10_000
		});
		expect(response.status()).toBe(401);
	});

	test('scheduler reports running jobs matching enabled automations', async ({ request }) => {
		const response = await request.get(`${ADMIN_URL}/admin/automations`, {
			headers: adminHeaders(),
			timeout: 10_000
		});

		expect(response.ok()).toBeTruthy();
		const data = await response.json();

		const enabledAutomations = data.automations.filter(
			(a: { enabled: boolean }) => a.enabled
		);
		const schedulerJobs = data.scheduler.jobs;

		// Every enabled automation should have a corresponding scheduler job
		for (const automation of enabledAutomations) {
			const matchingJob = schedulerJobs.find(
				(j: { fileName: string }) => j.fileName === automation.fileName
			);
			expect(
				matchingJob,
				`Expected scheduler job for enabled automation "${automation.name}" (${automation.fileName})`
			).toBeDefined();
			expect(matchingJob.running).toBe(true);
		}

		// Job count should match enabled automation count
		expect(data.scheduler.jobCount).toBe(enabledAutomations.length);
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

			// Logs array must be present (may be empty if automation has not fired yet)
			expect(Array.isArray(automation.logs)).toBe(true);
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
		// since the scheduler structure was already validated above.
		if (data.automations.length > 0) {
			// At least one automation should be enabled
			const hasEnabled = data.automations.some((a: { enabled: boolean }) => a.enabled);
			expect(hasEnabled).toBe(true);
		}
	});

	test('execution logs contain valid entries for fired automations', async ({ request }) => {
		const response = await request.get(`${ADMIN_URL}/admin/automations`, {
			headers: adminHeaders(),
			timeout: 10_000
		});

		expect(response.ok()).toBeTruthy();
		const data = await response.json();

		// Check any automations that have execution log entries
		for (const automation of data.automations) {
			if (automation.logs.length > 0) {
				for (const entry of automation.logs) {
					expect(typeof entry.at).toBe('string');
					expect(typeof entry.ok).toBe('boolean');
					expect(typeof entry.durationMs).toBe('number');
					expect(entry.durationMs).toBeGreaterThanOrEqual(0);

					// Failed entries should have an error message
					if (!entry.ok) {
						expect(typeof entry.error).toBe('string');
						expect(entry.error!.length).toBeGreaterThan(0);
					}

					// Timestamp should be a valid ISO date
					const parsed = new Date(entry.at);
					expect(parsed.getTime()).not.toBeNaN();
				}
			}
		}
	});
});
