/**
 * Regression test for #585 decision 585-B: `performUpgrade` must reclaim the
 * retired /opt/openpalm volumes (assistant-artifacts, guardian-cache,
 * portal-cache) as part of applying the new stack — AFTER the new containers
 * are confirmed up (never before `applyStack` succeeds), and a reclaim
 * failure must never throw / strand the upgrade.
 *
 * `applyStack` and `reapRetiredVolumes` are both statically imported by
 * lifecycle.ts, so this test mocks them via `mock.module` and re-imports
 * lifecycle.ts with a cache-busting query — the same pattern used by
 * lifecycle-install-ownership.test.ts / akm-stats.test.ts.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realDocker from './docker.js';
import * as realActivation from './activation.js';
import * as realImageVolumeRetention from './image-volume-retention.js';
import { readStackEnv } from './secrets.js';

const realApplyStack = realDocker.applyStack;
const realActivateStack = realActivation.activateStack;
const realReapRetiredVolumes = realImageVolumeRetention.reapRetiredVolumes;

// mock.module() is NOT undone by mock.restore() and leaks across test files
// sharing this bun test process — always re-point back to the real
// implementation afterward (mirrors lifecycle-install-ownership.test.ts).
afterEach(() => {
	mock.restore();
	mock.module('./docker.js', () => ({ ...realDocker, applyStack: realApplyStack }));
	mock.module('./activation.js', () => ({ ...realActivation, activateStack: realActivateStack }));
	mock.module('./image-volume-retention.js', () => ({
		...realImageVolumeRetention,
		reapRetiredVolumes: realReapRetiredVolumes
	}));
});

function withUpgradeEnv(homeDir: string, run: () => Promise<void>): Promise<void> {
	const saved = {
		OP_HOME: process.env.OP_HOME,
		OP_SKIP_COMPOSE_PREFLIGHT: process.env.OP_SKIP_COMPOSE_PREFLIGHT,
		OP_SKIP_OWNERSHIP_RECONCILE: process.env.OP_SKIP_OWNERSHIP_RECONCILE
	};
	process.env.OP_HOME = homeDir;
	process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
	process.env.OP_SKIP_OWNERSHIP_RECONCILE = '1';
	return run().finally(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
			else process.env[key as keyof NodeJS.ProcessEnv] = value;
		}
	});
}

describe('performUpgrade reclaims retired volumes after the new stack is up (#585 decision 585-B)', () => {
	test('calls reapRetiredVolumes exactly once, with the resolved project name, AFTER applyStack succeeds', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-upgrade-reap-'));
		try {
			await withUpgradeEnv(homeDir, async () => {
				let applyStackCalled = false;
				let reapCalledAfterApplyStack = false;
				let reapCalledWithProject: string | undefined;

				const applyStackMock = mock(async () => {
					applyStackCalled = true;
					return { ok: true };
				});
				const reapMock = mock(async (projectName: string) => {
					reapCalledAfterApplyStack = applyStackCalled;
					reapCalledWithProject = projectName;
					return { reclaimed: [], errors: [] };
				});

				mock.module('./docker.js', () => ({ ...realDocker, applyStack: applyStackMock }));
				mock.module('./activation.js', () => ({
					...realActivation,
					activateStack: applyStackMock
				}));
				mock.module('./image-volume-retention.js', () => ({
					...realImageVolumeRetention,
					reapRetiredVolumes: reapMock
				}));

				const { performUpgrade, createState } = await import(
					`./lifecycle.js?reap-test=${Math.random()}`
				);
				const state = createState();
				await performUpgrade(state);

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

	test('a reclaim failure is collected, never thrown — the upgrade still succeeds', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-upgrade-reap-fail-'));
		try {
			await withUpgradeEnv(homeDir, async () => {
				const applyStackMock = mock(async () => ({ ok: true }));
				const reapMock = mock(async () => ({
					reclaimed: [],
					errors: ['volume openpalm_guardian-cache: volume is in use']
				}));

				mock.module('./docker.js', () => ({ ...realDocker, applyStack: applyStackMock }));
				mock.module('./activation.js', () => ({
					...realActivation,
					activateStack: applyStackMock
				}));
				mock.module('./image-volume-retention.js', () => ({
					...realImageVolumeRetention,
					reapRetiredVolumes: reapMock
				}));

				const { performUpgrade, createState } = await import(
					`./lifecycle.js?reap-fail-test=${Math.random()}`
				);
				const state = createState();

				// Must not throw — a reclaim failure can never strand the deploy.
				await expect(performUpgrade(state)).resolves.toBeUndefined();
				expect(reapMock).toHaveBeenCalledTimes(1);
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});
