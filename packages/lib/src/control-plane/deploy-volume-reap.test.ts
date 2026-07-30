/**
 * Reviewer blocker (B1-volumes round 1): the #585 retired-volume reaper
 * (decision 585-B) was wired ONLY into `performUpgrade` — but `openpalm
 * install` on an existing OP_HOME (the documented repair/re-run path) drives
 * the SAME compose transition through `runDeploy` (deploy.ts): `applyInstall`
 * overwrites the managed system/stack compose files wholesale, then
 * `applyStack` brings the new stack up. Without a reap wired into THAT path
 * too, a user who runs `openpalm install` instead of `openpalm update`
 * strands the retired volumes (assistant-artifacts, guardian-cache,
 * portal-cache) permanently — `uninstall --volumes` can't see them (their
 * compose declarations are gone) and `doctor --clean-docker` can't either
 * (`findOrphanVolumes` only flags a DIFFERENT project's volumes).
 *
 * Mirrors lifecycle-volume-reap.test.ts: `runDeploy` must reap exactly once,
 * strictly AFTER `applyStack` succeeds, with the resolved project name, and
 * a reclaim failure must never throw / block setup completion. A third test
 * pins the negative: no reap call at all on the `applyStack` failure branch.
 *
 * `applyStack`/`composePs`/`detectExistingProject` and `reapRetiredVolumes`
 * are all statically imported (by docker.js / deploy.ts / image-volume-retention.js
 * respectively), so this test mocks them via `mock.module` and re-imports
 * deploy.js with a cache-busting query — the same pattern used by
 * lifecycle-volume-reap.test.ts / lifecycle-install-ownership.test.ts.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realDocker from './docker.js';
import * as realActivation from './activation.js';
import * as realImageVolumeRetention from './image-volume-retention.js';
import { runHomeMigrations } from './home-schema.js';
import { readStackEnv } from './secrets.js';
import { CORE_SERVICES } from './types.js';

const realApplyStack = realDocker.applyStack;
const realActivateStack = realActivation.activateStack;
const realComposePs = realDocker.composePs;
const realDetectExistingProject = realDocker.detectExistingProject;
const realReapRetiredVolumes = realImageVolumeRetention.reapRetiredVolumes;

// mock.module() is NOT undone by mock.restore() and leaks across test files
// sharing this bun test process — always re-point back to the real
// implementation afterward (mirrors lifecycle-volume-reap.test.ts's comment).
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
	process.env.OP_UI_LOGIN_PASSWORD = 'test-password-for-deploy-reap-test';
	return run().finally(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
			else process.env[key as keyof NodeJS.ProcessEnv] = value;
		}
	});
}

/**
 * Run the home-schema migrations over a throwaway home seeded with `content`
 * and return the resulting state/stack.env. Lets a rollback assertion say
 * "the pre-deploy file, as migrated" without hard-coding the current schema's
 * output. Reads nothing from process.env, so it is safe to call inside
 * withDeployEnv (which points OP_HOME at a different directory).
 */
function migratedStackEnv(content: string): string {
	const referenceHome = mkdtempSync(join(tmpdir(), 'openpalm-stack-env-migration-reference-'));
	try {
		mkdirSync(join(referenceHome, 'state'), { recursive: true });
		writeFileSync(join(referenceHome, 'state', 'stack.env'), content);
		runHomeMigrations(referenceHome);
		return readFileSync(join(referenceHome, 'state', 'stack.env'), 'utf8');
	} finally {
		rmSync(referenceHome, { recursive: true, force: true });
	}
}

describe('runDeploy reclaims retired volumes after the new stack is up (#585 decision 585-B, install path)', () => {
	test('calls reapRetiredVolumes exactly once, with the resolved project name, AFTER applyStack succeeds', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-deploy-reap-'));
		try {
			await withDeployEnv(homeDir, async () => {
				let applyStackCalled = false;
				let reapCalledAfterApplyStack = false;
				let reapCalledWithProject: string | undefined;

				const applyStackMock = mock(async () => {
					applyStackCalled = true;
					return { ok: true };
				});
				const composePsMock = mock(async () => ({ ok: true, stdout: '' }));
				const detectExistingProjectMock = mock(async () => ({ exists: false }));
				const reapMock = mock(async (projectName: string) => {
					reapCalledAfterApplyStack = applyStackCalled;
					reapCalledWithProject = projectName;
					return { reclaimed: [], errors: [] };
				});

				mock.module('./docker.js', () => ({
					...realDocker,
					applyStack: applyStackMock,
					composePs: composePsMock,
					detectExistingProject: detectExistingProjectMock
				}));
				mock.module('./activation.js', () => ({
					...realActivation,
					activateStack: applyStackMock
				}));
				mock.module('./image-volume-retention.js', () => ({
					...realImageVolumeRetention,
					reapRetiredVolumes: reapMock
				}));

				const { runDeploy } = await import(`./deploy.js?deploy-reap-test=${Math.random()}`);
				const { createState } = await import(
					`./lifecycle.js?deploy-reap-test-state=${Math.random()}`
				);
				const state = createState();

				const result = await runDeploy(state);

				expect(result.deployError).toBeNull();
				expect(result.setupComplete).toBe(true);
				expect(applyStackMock).toHaveBeenCalledTimes(1);
				expect(reapMock).toHaveBeenCalledTimes(1);
				expect(reapCalledAfterApplyStack).toBe(true);
				expect(reapCalledWithProject).toBe(
					realDocker.resolveComposeProjectName(readStackEnv(homeDir))
				);
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	test('a reclaim failure is collected, never thrown — setup still completes', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-deploy-reap-fail-'));
		try {
			await withDeployEnv(homeDir, async () => {
				const applyStackMock = mock(async () => ({ ok: true }));
				const composePsMock = mock(async () => ({ ok: true, stdout: '' }));
				const detectExistingProjectMock = mock(async () => ({ exists: false }));
				const reapMock = mock(async () => ({
					reclaimed: [],
					errors: ['volume openpalm_guardian-cache: volume is in use']
				}));

				mock.module('./docker.js', () => ({
					...realDocker,
					applyStack: applyStackMock,
					composePs: composePsMock,
					detectExistingProject: detectExistingProjectMock
				}));
				mock.module('./activation.js', () => ({
					...realActivation,
					activateStack: applyStackMock
				}));
				mock.module('./image-volume-retention.js', () => ({
					...realImageVolumeRetention,
					reapRetiredVolumes: reapMock
				}));

				const { runDeploy } = await import(`./deploy.js?deploy-reap-fail-test=${Math.random()}`);
				const { createState } = await import(
					`./lifecycle.js?deploy-reap-fail-test-state=${Math.random()}`
				);
				const state = createState();

				const result = await runDeploy(state);

				// A reclaim failure must never strand setup — deployError stays null.
				expect(result.deployError).toBeNull();
				expect(result.setupComplete).toBe(true);
				expect(reapMock).toHaveBeenCalledTimes(1);
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	test("never reaps when applyStack fails (no false 'volumes reclaimed' on a broken deploy)", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-deploy-reap-noop-'));
		try {
			await withDeployEnv(homeDir, async () => {
				const applyStackMock = mock(async () => ({ ok: false, upFailed: true, error: 'boom' }));
				const composePsMock = mock(async () => ({ ok: true, stdout: '' }));
				const detectExistingProjectMock = mock(async () => ({ exists: false }));
				const reapMock = mock(async () => ({ reclaimed: [], errors: [] }));

				mock.module('./docker.js', () => ({
					...realDocker,
					applyStack: applyStackMock,
					composePs: composePsMock,
					detectExistingProject: detectExistingProjectMock
				}));
				mock.module('./activation.js', () => ({
					...realActivation,
					activateStack: applyStackMock
				}));
				mock.module('./image-volume-retention.js', () => ({
					...realImageVolumeRetention,
					reapRetiredVolumes: reapMock
				}));

				const { runDeploy } = await import(`./deploy.js?deploy-reap-noop-test=${Math.random()}`);
				const { createState } = await import(
					`./lifecycle.js?deploy-reap-noop-test-state=${Math.random()}`
				);
				const state = createState();

				const result = await runDeploy(state);

				expect(result.deployError).not.toBeNull();
				expect(reapMock).toHaveBeenCalledTimes(0);
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	test('returns a structured error and restores files when activation audit throws', async () => {
		const seedStackEnv = 'OP_ASSISTANT_VERSION=custom-pin\nOP_SETUP_COMPLETE=false\n';
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-deploy-activation-audit-'));
		try {
			mkdirSync(join(homeDir, 'state'), { recursive: true });
			writeFileSync(join(homeDir, 'state', 'stack.env'), seedStackEnv);
			await withDeployEnv(homeDir, async () => {
				const activationError = new Error('Refusing Compose stack activation: secret-boundary audit failed.');
				const activateStackMock = mock(async () => { throw activationError; });
				mock.module('./docker.js', () => ({
					...realDocker,
					detectExistingProject: mock(async () => ({ exists: false }))
				}));
				mock.module('./activation.js', () => ({
					...realActivation,
					activateStack: activateStackMock
				}));

				const { runDeploy } = await import(`./deploy.js?deploy-activation-audit=${Math.random()}`);
				const { createState } = await import(`./lifecycle.js?deploy-activation-audit-state=${Math.random()}`);
				const result = await runDeploy(createState());

				expect(result.deploying).toBe(false);
				expect(result.deployError).toContain('secret-boundary audit failed');
				// The rollback target is the pre-deploy file AS MIGRATED, not the bytes
				// the operator's copy happened to hold. applyManagedFiles deliberately
				// runs runHomeMigrations BEFORE it snapshots (lifecycle.ts explains why),
				// so a failed deploy can never strand a half-migrated home — a schema
				// upgrade is not part of whichever deploy it travelled with, and undoing
				// it would only make the next boot redo it.
				//
				// Derive the expectation by migrating a pristine copy of the same seed
				// rather than re-pinning a literal: the assertion stays byte-exact, so
				// any deploy-time write to stack.env still fails it, but a future
				// migration that legitimately adds a key does not have to be transcribed
				// into this test to keep it honest.
				expect(readFileSync(join(homeDir, 'state', 'stack.env'), 'utf8')).toBe(
					migratedStackEnv(seedStackEnv)
				);
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	test('an enabled guardian is required even though it is not a core service', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-deploy-guardian-fail-'));
		try {
			expect(CORE_SERVICES).toEqual(['assistant']);
			mkdirSync(join(homeDir, 'state'), { recursive: true });
			writeFileSync(join(homeDir, 'state', 'stack.env'), 'OP_ENABLED_ADDONS=discord\n');

			await withDeployEnv(homeDir, async () => {
				let applyCalls = 0;
				const applyStackMock = mock(async () => {
					applyCalls++;
					return applyCalls === 1 ? { ok: false } : { ok: true };
				});
				const composePsMock = mock(async () => ({
					ok: true,
					stdout: JSON.stringify([
						{ Service: 'assistant', State: 'running', Health: '' },
						{ Service: 'discord', State: 'running', Health: '' }
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
				mock.module('./activation.js', () => ({
					...realActivation,
					activateStack: applyStackMock
				}));
				mock.module('./image-volume-retention.js', () => ({
					...realImageVolumeRetention,
					reapRetiredVolumes: reapMock
				}));

				const { runDeploy } = await import(
					`./deploy.js?deploy-guardian-fail-test=${Math.random()}`
				);
				const { createState } = await import(
					`./lifecycle.js?deploy-guardian-fail-test-state=${Math.random()}`
				);
				const result = await runDeploy(createState());

				expect(result.setupComplete).toBe(false);
				expect(result.deployError).toContain('guardian');
				expect(result.imageWarning).toBeNull();
				expect(reapMock).not.toHaveBeenCalled();
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	test('a required service still in health-starting state cannot complete setup', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-deploy-health-starting-'));
		try {
			await withDeployEnv(homeDir, async () => {
				let applyCalls = 0;
				const applyStackMock = mock(async () => {
					applyCalls++;
					return applyCalls === 1 ? { ok: false, upFailed: false } : { ok: true };
				});
				const composePsMock = mock(async () => ({
					ok: true,
					stdout: JSON.stringify([{ Service: 'assistant', State: 'running', Health: 'starting' }])
				}));
				const detectExistingProjectMock = mock(async () => ({ exists: false }));
				const reapMock = mock(async () => ({ reclaimed: [], errors: [] }));

				mock.module('./docker.js', () => ({
					...realDocker,
					applyStack: applyStackMock,
					composePs: composePsMock,
					detectExistingProject: detectExistingProjectMock
				}));
				mock.module('./activation.js', () => ({
					...realActivation,
					activateStack: applyStackMock
				}));
				mock.module('./image-volume-retention.js', () => ({
					...realImageVolumeRetention,
					reapRetiredVolumes: reapMock
				}));

				const { runDeploy } = await import(
					`./deploy.js?deploy-health-starting-test=${Math.random()}`
				);
				const { createState } = await import(
					`./lifecycle.js?deploy-health-starting-state=${Math.random()}`
				);
				const result = await runDeploy(createState());

				expect(result.setupComplete).toBe(false);
				expect(result.deployError).toContain('assistant');
				expect(result.deployStatus).toContainEqual({
					service: 'assistant',
					status: 'error',
					label: 'Starting'
				});
				expect(reapMock).not.toHaveBeenCalled();
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	// Optional adapter failures still complete setup, and the retired-volume
	// reaper must run before this early return.
	test('still reaps when only an optional adapter fails to start', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-deploy-reap-optional-fail-'));
		try {
			// Enable Discord so static inference includes required Guardian and the
			// optional adapter itself.
			mkdirSync(join(homeDir, 'state'), { recursive: true });
			writeFileSync(join(homeDir, 'state', 'stack.env'), 'OP_ENABLED_ADDONS=discord\n');

			await withDeployEnv(homeDir, async () => {
				const applyStackMock = mock(async () => ({ ok: false }));
				// Required Assistant + Guardian report healthy; Discord is absent from
				// `compose ps` output entirely ("Did not start").
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
				mock.module('./activation.js', () => ({
					...realActivation,
					activateStack: applyStackMock
				}));
				mock.module('./image-volume-retention.js', () => ({
					...realImageVolumeRetention,
					reapRetiredVolumes: reapMock
				}));

				const { runDeploy } = await import(
					`./deploy.js?deploy-reap-optional-fail-test=${Math.random()}`
				);
				const { createState } = await import(
					`./lifecycle.js?deploy-reap-optional-fail-test-state=${Math.random()}`
				);
				const state = createState();

				const result = await runDeploy(state);

				// Only an optional adapter failed, so setup still completes.
				expect(result.deployError).toBeNull();
				expect(result.setupComplete).toBe(true);
				expect(result.imageWarning).toContain('discord');
				// The retired volumes must still be reclaimed on this branch.
				expect(reapMock).toHaveBeenCalledTimes(1);
				expect(reapMock.mock.calls[0]?.[0]).toBe(
					realDocker.resolveComposeProjectName(readStackEnv(homeDir))
				);
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});
