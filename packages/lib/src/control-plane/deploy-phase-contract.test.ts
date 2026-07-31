/**
 * Contract test (W5, W7): pins the exact phase sequence and per-service
 * status values `runDeploy` emits against what the client actually switches
 * on (setup-state.svelte.ts's `pollDeployStatus`, DeployStep.svelte's phase
 * copy). The review's central finding across both bugs was that no test
 * exercised producer and consumer together — a phase the UI has copy for
 * (`pulling-images`) went unemitted, and a status the client's poll loop
 * watches for (`warning`) went unproduced, so each drifted silently.
 *
 * Mocks docker.js/activation.js the same way deploy-volume-reap.test.ts does:
 * mock.module() is NOT undone by mock.restore() and leaks across test files
 * sharing this bun test process, so every test restores the real
 * implementations afterward.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realDocker from './docker.js';
import * as realActivation from './activation.js';
import * as realImageVolumeRetention from './image-volume-retention.js';
import type { DeployPhase, DeployProgress } from './deploy.js';

const realApplyStack = realDocker.applyStack;
const realActivateStack = realActivation.activateStack;
const realComposePs = realDocker.composePs;
const realDetectExistingProject = realDocker.detectExistingProject;
const realReapRetiredVolumes = realImageVolumeRetention.reapRetiredVolumes;

afterEach(() => {
	mock.restore();
	mock.module('./docker.js', () => ({
		...realDocker,
		applyStack: realApplyStack,
		composePs: realComposePs,
		detectExistingProject: realDetectExistingProject
	}));
	mock.module('./activation.js', () => ({ ...realActivation, activateStack: realActivateStack }));
	mock.module('./image-volume-retention.js', () => ({
		...realImageVolumeRetention,
		reapRetiredVolumes: realReapRetiredVolumes
	}));
});

function withDeployEnv(homeDir: string, run: () => Promise<void>): Promise<void> {
	const saved = {
		OP_HOME: process.env.OP_HOME,
		OP_SKIP_COMPOSE_PREFLIGHT: process.env.OP_SKIP_COMPOSE_PREFLIGHT,
		OP_SKIP_OWNERSHIP_RECONCILE: process.env.OP_SKIP_OWNERSHIP_RECONCILE,
		OP_UI_LOGIN_PASSWORD: process.env.OP_UI_LOGIN_PASSWORD
	};
	process.env.OP_HOME = homeDir;
	process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
	process.env.OP_SKIP_OWNERSHIP_RECONCILE = '1';
	process.env.OP_UI_LOGIN_PASSWORD = 'test-password-for-deploy-phase-contract-test';
	return run().finally(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
			else process.env[key as keyof NodeJS.ProcessEnv] = value;
		}
	});
}

describe('runDeploy phase/status contract (W5, W7)', () => {
	test('W7: announces pulling-images before starting, ending on ready — the pull is never silently folded into "starting"', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-deploy-phase-'));
		try {
			await withDeployEnv(homeDir, async () => {
				const applyStackMock = mock(async () => ({ ok: true }));
				const composePsMock = mock(async () => ({
					ok: true,
					stdout: JSON.stringify([{ Service: 'assistant', State: 'running', Health: '' }])
				}));
				const detectExistingProjectMock = mock(async () => ({ exists: false }));
				const reapMock = mock(async () => ({ reclaimed: [], errors: [] }));

				mock.module('./docker.js', () => ({
					...realDocker,
					applyStack: applyStackMock,
					composePs: composePsMock,
					detectExistingProject: detectExistingProjectMock
				}));
				mock.module('./activation.js', () => ({ ...realActivation, activateStack: applyStackMock }));
				mock.module('./image-volume-retention.js', () => ({
					...realImageVolumeRetention,
					reapRetiredVolumes: reapMock
				}));

				const { runDeploy } = await import(`./deploy.js?deploy-phase-test=${Math.random()}`);
				const { createState } = await import(
					`./lifecycle.js?deploy-phase-test-state=${Math.random()}`
				);
				const state = createState();

				const phasesSeen: DeployPhase[] = [];
				const result: DeployProgress = await runDeploy(state, {
					onUpdate: (p: DeployProgress) => { phasesSeen.push(p.phase); }
				});

				expect(result.deployError).toBeNull();
				expect(result.phase).toBe('ready');

				// The exact bug W7 describes: the pull never got its own phase, so the
				// wizard sat on 'starting' — "0 of N services running" — for the whole
				// multi-minute download. Pin that 'pulling-images' actually fires, and
				// fires strictly BEFORE 'starting' (never skipped, never reordered).
				const pullIndex = phasesSeen.indexOf('pulling-images');
				const startIndex = phasesSeen.indexOf('starting');
				expect(pullIndex).toBeGreaterThanOrEqual(0);
				expect(startIndex).toBeGreaterThan(pullIndex);
				expect(phasesSeen[phasesSeen.length - 1]).toBe('ready');
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	test("W5: an optional-only failure reports the failed row as 'warning' — the only status the client's poll loop treats as a non-blocking terminal state", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-deploy-warning-contract-'));
		try {
			// Enable Discord so static inference includes required Guardian and the
			// optional adapter itself (mirrors deploy-volume-reap.test.ts's fixture).
			mkdirSync(join(homeDir, 'state'), { recursive: true });
			writeFileSync(join(homeDir, 'state', 'stack.env'), 'OP_ENABLED_ADDONS=discord\n');

			await withDeployEnv(homeDir, async () => {
				const applyStackMock = mock(async () => ({ ok: false }));
				// Required Assistant + Guardian report healthy; Discord is absent from
				// `compose ps` entirely ("Did not start") — an optional-only failure.
				const composePsMock = mock(async () => ({
					ok: true,
					stdout: JSON.stringify([
						{ Service: 'assistant', State: 'running', Health: '' },
						{ Service: 'guardian', State: 'running', Health: '' }
					])
				}));
				const detectExistingProjectMock = mock(async () => ({ exists: false }));
				const reapMock = mock(async () => ({ reclaimed: [], errors: [] }));

				mock.module('./docker.js', () => ({
					...realDocker,
					applyStack: applyStackMock,
					composePs: composePsMock,
					detectExistingProject: detectExistingProjectMock
				}));
				mock.module('./activation.js', () => ({ ...realActivation, activateStack: applyStackMock }));
				mock.module('./image-volume-retention.js', () => ({
					...realImageVolumeRetention,
					reapRetiredVolumes: reapMock
				}));

				const { runDeploy } = await import(`./deploy.js?deploy-warning-test=${Math.random()}`);
				const { createState } = await import(
					`./lifecycle.js?deploy-warning-test-state=${Math.random()}`
				);
				const state = createState();

				const result: DeployProgress = await runDeploy(state);

				expect(result.deployError).toBeNull();
				expect(result.setupComplete).toBe(true);
				const discordRow = result.deployStatus.find((s) => s.service === 'discord');
				expect(discordRow?.status).toBe('warning');

				// Mirrors setup-state.svelte.ts's pollDeployStatus terminal check
				// exactly — the real consumer-side predicate the wizard polls until
				// satisfied. Before the W5 fix nothing ever produced 'warning', so this
				// predicate could never go true and the wizard polled forever on a
				// deploy that had, in fact, already succeeded.
				const rows = result.deployStatus;
				const onlyWarningsLeft =
					!result.deploying &&
					rows.every((s) => s.status === 'running' || s.status === 'warning') &&
					rows.some((s) => s.status === 'warning');
				expect(onlyWarningsLeft).toBe(true);
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});
