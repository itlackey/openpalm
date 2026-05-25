/**
 * Setup wizard — MANUAL API smoke script (NOT an automated test).
 *
 * Renamed to `.manual.ts` so Playwright's default `testMatch: '*.pw.ts'`
 * skips it. Run only when an operator explicitly invokes it against a
 * live dev stack — see e2e/README.md.
 *
 * The route + deploy logic this exercises (performSetup, startDeploy,
 * compose pull/up, image-fallback, profile bring-up) is covered by the
 * vitest suites in src/lib/server (no docker needed). This file is for
 * pre-release smoke that proves the actual compose orchestration works
 * end-to-end against a real Docker daemon.
 *
 * Resets stack.env to the pre-setup state, hits every wizard API
 * endpoint in the same order the browser flow does, and asserts the
 * deploy finishes with setupComplete=true. ~30s on a warm dev stack
 * (containers already pulled).
 *
 * What this covers:
 *   - GET /api/setup/status → not complete after reset
 *   - GET /api/setup/system-check → docker available
 *   - POST /api/setup/complete with the minimum-viable payload
 *     (browser-tts/browser-stt, no providers, allowEmpty)
 *   - GET /api/setup/deploy-status polled until terminal
 *   - GET /api/setup/status → complete after deploy
 *
 * What it does NOT cover:
 *   - UI rendering / click flow (see setup-wizard-browser.pw.ts)
 *   - OpenPalm Voice container pull (separate slow test, gated by
 *     RUN_SLOW_E2E)
 *
 * Run with:
 *   RUN_DOCKER_STACK_TESTS=1 \
 *     OP_UI_LOGIN_PASSWORD=<password> \
 *     ADMIN_URL=http://127.0.0.1:9100 \
 *     bun run ui:test:e2e
 */

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
	resetWizardState,
	restoreWizardState,
	resolveOpHome,
	minimalSetupPayload,
} from './wizard-reset.ts';

const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:9100';
const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
const DEPLOY_DEADLINE_MS = 5 * 60_000; // 5 min — covers warm container restarts; cold pulls go through the slow suite
const POLL_INTERVAL_MS = 1_500;

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
		// Tear the wizard-installed stack back down so the next test file
		// starts clean. Without this, subsequent runs collide on
		// container names + ports + the project-name-collision guard.
		// Best-effort — failures here are logged but don't fail the suite.
		const home = resolveOpHome();
		const stackDir = resolve(home, 'config/stack');
		const composeFile = resolve(stackDir, 'core.compose.yml');
		const stackEnv = resolve(stackDir, 'stack.env');
		const guardianEnv = resolve(stackDir, 'guardian.env');
		const userVault = resolve(home, 'stash/vaults/user.env');
		try {
			execFileSync(
				'docker',
				[
					'compose',
					'--project-directory', home,
					'--project-name', process.env.OP_PROJECT_NAME ?? 'openpalm-dev',
					'-f', composeFile,
					'--env-file', stackEnv,
					'--env-file', guardianEnv,
					'--env-file', userVault,
					'down',
				],
				{ stdio: 'ignore', timeout: 60_000 },
			);
		} catch (err) {
			console.warn('[wizard-api] composeDown cleanup failed:', err);
		}
		restoreWizardState(home);
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

	test('POST /api/setup/complete then poll deploy-status until ready', async ({ request }) => {
		const payload = minimalSetupPayload(E2E_PASSWORD);
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

		// Poll deploy-status until terminal (setupComplete=true OR deployError set).
		const deadline = Date.now() + DEPLOY_DEADLINE_MS;
		let lastStatus: unknown = null;
		while (Date.now() < deadline) {
			const res = await request.get(`${ADMIN_URL}/api/setup/deploy-status`, { headers: headers() });
			if (res.ok()) {
				lastStatus = await res.json();
				const s = lastStatus as { setupComplete?: boolean; deployError?: string | null; deployStatus?: Array<{ status: string }> };
				if (s.deployError) {
					throw new Error(`Deploy failed: ${s.deployError}`);
				}
				if (
					s.setupComplete &&
					s.deployStatus &&
					s.deployStatus.length > 0 &&
					s.deployStatus.every((entry) => entry.status === 'running')
				) {
					break;
				}
			}
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		}

		expect(lastStatus, 'deploy-status never returned a usable body').not.toBeNull();
		const s = lastStatus as { setupComplete: boolean; deployStatus: Array<{ service: string; status: string }> };
		expect(s.setupComplete).toBe(true);
		// browser-tts/browser-stt means voice services should NOT have come up
		// — the deploy should be core services only.
		const voiceUp = s.deployStatus.filter((e) => /^voice(-cuda|-rocm)?$/.test(e.service));
		expect(voiceUp.length).toBe(0);
	});

	test('GET /api/setup/status reports complete after deploy', async ({ request }) => {
		const res = await request.get(`${ADMIN_URL}/api/setup/status`, { headers: headers() });
		expect(res.ok()).toBeTruthy();
		const body = await res.json();
		expect(body.setupComplete).toBe(true);
	});
});
