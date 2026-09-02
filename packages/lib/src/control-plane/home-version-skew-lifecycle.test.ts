/**
 * Regression tests for #636 at the lifecycle entry points: `applyInstall`,
 * `applyUpdate`, and `performUpgrade` must refuse a home stamped newer than
 * the running app BEFORE doing any work — no ownership reconcile, no backup,
 * no Docker call, nothing. That "before any work" property is what a plain
 * unit test on `detectHomeVersionSkew` (home-version-skew.test.ts) cannot
 * prove by itself; these tests mock the first write/Docker call each entry
 * point would otherwise make and assert it is never reached.
 *
 * `reconcileHostOwnership`/`backupOpenPalmHome`/the Docker client are
 * statically imported by lifecycle.ts, so — mirroring
 * lifecycle-install-ownership.test.ts and lifecycle-rollback-pin.test.ts —
 * each test mocks the relevant module via `mock.module` and re-imports
 * lifecycle.ts with a cache-busting query.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realOwnershipReconcile from './ownership-reconcile.js';
import * as realBackup from './backup.js';
import * as realDocker from './docker.js';
import * as realActivation from './activation.js';
import { SKELETON_VERSION_STAMP } from './ui-assets.js';

const realReconcileHostOwnership = realOwnershipReconcile.reconcileHostOwnership;
const realBackupOpenPalmHome = realBackup.backupOpenPalmHome;
const realDockerClient = realDocker.realDockerClient;
const realActivateStack = realActivation.activateStack;

// mock.module() is NOT undone by mock.restore() and leaks across test files
// sharing this bun test process — always re-point back to the real
// implementation afterward (same pattern as lifecycle-install-ownership.test.ts
// / lifecycle-rollback-pin.test.ts).
afterEach(() => {
	mock.restore();
	mock.module('./ownership-reconcile.js', () => ({
		...realOwnershipReconcile,
		reconcileHostOwnership: realReconcileHostOwnership
	}));
	mock.module('./backup.js', () => ({ ...realBackup, backupOpenPalmHome: realBackupOpenPalmHome }));
	mock.module('./docker.js', () => ({ ...realDocker, realDockerClient: realDockerClient }));
	mock.module('./activation.js', () => ({ ...realActivation, activateStack: realActivateStack }));
});

function withEnv(homeDir: string, run: () => Promise<void>): Promise<void> {
	const saved = {
		OP_HOME: process.env.OP_HOME,
		OP_SKIP_COMPOSE_PREFLIGHT: process.env.OP_SKIP_COMPOSE_PREFLIGHT,
		OP_SKIP_OWNERSHIP_RECONCILE: process.env.OP_SKIP_OWNERSHIP_RECONCILE
	};
	process.env.OP_HOME = homeDir;
	process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
	delete process.env.OP_SKIP_OWNERSHIP_RECONCILE;
	return run().finally(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
			else process.env[key as keyof NodeJS.ProcessEnv] = value;
		}
	});
}

describe('applyInstall refuses a home stamped newer than this app, before any write (#636)', () => {
	test('never calls reconcileHostOwnership and never creates system/', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-skew-install-'));
		try {
			// A home someone already seeded (e.g. a partially-run newer install, or
			// a copied-over OP_HOME) at a version ahead of the code running now.
			mkdirSync(homeDir, { recursive: true });
			writeFileSync(join(homeDir, SKELETON_VERSION_STAMP), '99.0.0\n');

			await withEnv(homeDir, async () => {
				const reconcileHostOwnershipMock = mock(async () => {});
				mock.module('./ownership-reconcile.js', () => ({
					...realOwnershipReconcile,
					reconcileHostOwnership: reconcileHostOwnershipMock
				}));

				const { applyInstall, createState } = await import(
					`./lifecycle.js?skew-install-test=${Math.random()}`
				);
				const state = createState();

				await expect(applyInstall(state)).rejects.toThrow(/99\.0\.0/);
				expect(reconcileHostOwnershipMock).not.toHaveBeenCalled();
				// The managed tree was never written — this build's skeleton never
				// overwrote the newer home's.
				expect(existsSync(join(homeDir, 'system'))).toBe(false);
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});

describe('applyUpdate refuses a home stamped newer than this app, before any write (#636)', () => {
	test('never calls backupOpenPalmHome and leaves .skeleton-version untouched', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-skew-update-'));
		try {
			mkdirSync(join(homeDir, 'state'), { recursive: true });
			mkdirSync(join(homeDir, 'system'), { recursive: true });
			writeFileSync(join(homeDir, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
			writeFileSync(join(homeDir, SKELETON_VERSION_STAMP), '99.0.0\n');

			await withEnv(homeDir, async () => {
				const backupOpenPalmHomeMock = mock(() => null);
				mock.module('./backup.js', () => ({ ...realBackup, backupOpenPalmHome: backupOpenPalmHomeMock }));

				const { applyUpdate, createState } = await import(
					`./lifecycle.js?skew-update-test=${Math.random()}`
				);
				const state = createState();

				await expect(applyUpdate(state)).rejects.toThrow(/99\.0\.0/);
				expect(backupOpenPalmHomeMock).not.toHaveBeenCalled();
				expect(readFileSync(join(homeDir, SKELETON_VERSION_STAMP), 'utf-8').trim()).toBe('99.0.0');
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});

describe('performUpgrade refuses a home stamped newer than this app, before any Docker call (#636)', () => {
	test('never calls captureRunningImageIds / activateStack', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-skew-upgrade-'));
		try {
			mkdirSync(join(homeDir, 'state'), { recursive: true });
			mkdirSync(join(homeDir, 'system'), { recursive: true });
			writeFileSync(join(homeDir, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
			writeFileSync(join(homeDir, SKELETON_VERSION_STAMP), '99.0.0\n');

			await withEnv(homeDir, async () => {
				const dockerRunMock = mock(async () => ({ ok: true, stdout: '', stderr: '', code: 0 }));
				const activateStackMock = mock(async () => ({ ok: true }));
				mock.module('./docker.js', () => ({ ...realDocker, realDockerClient: { run: dockerRunMock } }));
				mock.module('./activation.js', () => ({ ...realActivation, activateStack: activateStackMock }));

				const { performUpgrade, createState } = await import(
					`./lifecycle.js?skew-upgrade-test=${Math.random()}`
				);
				const state = createState();

				await expect(performUpgrade(state)).rejects.toThrow(/99\.0\.0/);
				expect(dockerRunMock).not.toHaveBeenCalled();
				expect(activateStackMock).not.toHaveBeenCalled();
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});
