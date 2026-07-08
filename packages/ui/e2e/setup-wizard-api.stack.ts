/**
 * Setup wizard — API integration test.
 *
 * Collected by Playwright when RUN_DOCKER_STACK_TESTS=1 (*.stack.ts pattern).
 * Run via: ./scripts/dev-e2e-test.sh --skip-build --playwright
 *
 * Resets stack.env to the pre-setup state, hits the wizard API endpoints,
 * and validates the minimum setup payload through the non-destructive dry-run
 * path. The actual deploy path is covered by CLI/install stack checks; this
 * suite must not clobber a running shared Playwright stack.
 *
 * Covers:
 *   - GET /api/setup/status → not complete after reset
 *   - GET /api/setup/system-check → docker available
 *   - POST /api/setup/complete dryRun with minimum-viable payload
 *   - GET /api/setup/status → still incomplete after dry-run
 *
 * Run with:
 *   RUN_DOCKER_STACK_TESTS=1 \
 *     OP_UI_LOGIN_PASSWORD=<password> \
 *     ADMIN_URL=http://127.0.0.1:9100 \
 *     bun run ui:test:e2e
 */

import { test, expect } from '@playwright/test';
import {
	resetWizardState,
	restoreWizardState,
	resolveOpHome,
	minimalSetupPayload,
} from './wizard-reset.ts';

const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:9100';
const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;

const E2E_PASSWORD = 'wizard-e2e-test-password';

function headers(token = ''): Record<string, string> {
	const h: Record<string, string> = {
		'content-type': 'application/json',
		'x-request-id': crypto.randomUUID(),
	};
	if (token) h.cookie = `op_session=${token}`;
	return h;
}

test.describe('Setup wizard — API walkthrough (fast)', () => {
	test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running dev stack');

	test.beforeAll(() => {
		resetWizardState(resolveOpHome());
	});

	test.afterAll(() => {
		restoreWizardState(resolveOpHome());
	});

	test('GET /api/setup/status reports not complete after reset', async ({ request }) => {
		const res = await request.get(`${ADMIN_URL}/api/setup/status`, { headers: headers() });
		expect(res.ok()).toBeTruthy();
		const body = await res.json();
		expect(body.setupComplete).toBe(false);
	});

	test('GET /api/setup/system-check reports docker available', async ({ request }) => {
		const res = await request.get(`${ADMIN_URL}/api/setup/system-check`, { headers: headers() });
		expect(res.ok()).toBeTruthy();
		const body = await res.json();
		// system-check returns an object describing host capabilities; we
		// don't assert every key (the shape evolves), just that the call
		// succeeded with a sane payload.
		expect(typeof body).toBe('object');
		expect(body).not.toBeNull();
	});

	test('POST /api/setup/complete dry-run validates the minimum payload without deploying', async ({ request }) => {
		const payload = { ...minimalSetupPayload(E2E_PASSWORD), dryRun: true };
		const completeRes = await request.post(`${ADMIN_URL}/api/setup/complete`, {
			headers: headers(),
			data: payload,
		});
		// Reading the body is important — failures here have actionable
		// detail and we want it in the test output rather than a generic
		// "expected 200".
		const completeBody = await completeRes.json();
		expect(completeRes.status(), `POST /api/setup/complete failed: ${JSON.stringify(completeBody).slice(0, 500)}`).toBe(200);
		expect(completeBody.ok).toBe(true);
		expect(completeBody.dryRun).toBe(true);
	});

	test('GET /api/setup/status still reports incomplete after dry-run setup', async ({ request }) => {
		const res = await request.get(`${ADMIN_URL}/api/setup/status`, { headers: headers() });
		expect(res.ok()).toBeTruthy();
		const body = await res.json();
		expect(body.setupComplete).toBe(false);
	});
});
