/**
 * Regression coverage for #667: `openpalm update` exited 0 when both the
 * upgrade AND its automatic rollback failed and the stack was left down.
 * `isRollbackRecoveryFailure` (lifecycle.ts) is the marker `openpalm update`
 * (packages/cli/src/commands/update.ts's `describeUpgradeFailure`) checks to
 * pick a louder exit code and print the actual end state instead of a
 * one-size-fits-all hint. This drives the real `performUpgrade` through both
 * outcomes end-to-end: a mutation failure whose automatic rollback recovers
 * (marker stays false — the stack is running on its previous version), and
 * one whose rollback reapply ALSO fails (marker flips true — the stack is
 * down). Same mock.module technique as lifecycle-rollback-pin.test.ts.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realDocker from './docker.js';
import * as realActivation from './activation.js';

const realActivateStack = realActivation.activateStack;
const realDockerClient = realDocker.realDockerClient;
const realApplyStack = realDocker.applyStack;

afterEach(() => {
	mock.restore();
	mock.module('./docker.js', () => ({ ...realDocker, realDockerClient: realDockerClient, applyStack: realApplyStack }));
	mock.module('./activation.js', () => ({ ...realActivation, activateStack: realActivateStack }));
});

function withUpgradeEnv(homeDir: string, run: () => Promise<void>): Promise<void> {
	const saved = {
		OP_HOME: process.env.OP_HOME,
		OP_SKIP_COMPOSE_PREFLIGHT: process.env.OP_SKIP_COMPOSE_PREFLIGHT,
		OP_SKIP_OWNERSHIP_RECONCILE: process.env.OP_SKIP_OWNERSHIP_RECONCILE,
		// Defensive, not just relying on the global bunfig preload: some
		// unrelated file in the full (non-isolated) `bun test` run leaves
		// OP_ALLOW_ROOT unset (a pre-existing cross-file pollution gap, not
		// introduced here), which would otherwise fail this sandbox's
		// root-owned temp OP_HOME at the operator-identity persist guard
		// before performUpgrade ever reaches the code this file tests.
		OP_ALLOW_ROOT: process.env.OP_ALLOW_ROOT
	};
	process.env.OP_HOME = homeDir;
	process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
	process.env.OP_SKIP_OWNERSHIP_RECONCILE = '1';
	process.env.OP_ALLOW_ROOT = '1';
	return run().finally(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
			else process.env[key as keyof NodeJS.ProcessEnv] = value;
		}
	});
}

const RUNNING_CONTAINERS: Record<string, { image: string; service: string }> = {
	'cid-assistant': { image: 'openpalm/assistant:0.13.0', service: 'assistant' }
};

function fakeDockerClient() {
	return {
		run: mock(async (args: string[]) => {
			if (args.includes('ps') && args.at(-1) === '-q') {
				return { ok: true, stdout: `${Object.keys(RUNNING_CONTAINERS).join('\n')}\n`, stderr: '', code: 0 };
			}
			if (args[0] === 'inspect') {
				const ids = args.slice(3);
				const lines = ids.map((id, i) => {
					const row = RUNNING_CONTAINERS[id];
					return JSON.stringify({
						Image: `sha256:${'a'.repeat(63)}${i}`,
						Config: { Image: row.image, Labels: { 'com.docker.compose.service': row.service } }
					});
				});
				return { ok: true, stdout: `${lines.join('\n')}\n`, stderr: '', code: 0 };
			}
			if (args[0] === 'image' && args[1] === 'tag') {
				return { ok: true, stdout: '', stderr: '', code: 0 };
			}
			return { ok: true, stdout: '', stderr: '', code: 0 };
		})
	};
}

function seedHome(homeDir: string): void {
	mkdirSync(join(homeDir, 'state'), { recursive: true });
	writeFileSync(
		join(homeDir, 'state', 'stack.env'),
		[
			'OP_ASSISTANT_VERSION=0.13.0',
			'OP_GUARDIAN_VERSION=0.13.0',
			'OP_PORTAL_VERSION=0.13.0',
			'OP_MANAGED_ASSISTANT_VERSION=',
			'OP_MANAGED_GUARDIAN_VERSION=',
			'OP_MANAGED_PORTAL_VERSION=',
			'OP_VOICE_VERSION=latest',
			'OP_MANAGED_VOICE_VERSION=latest',
			''
		].join('\n')
	);
}

describe('isRollbackRecoveryFailure reflects whether performUpgrade\'s own automatic rollback recovered (#667)', () => {
	test('a mutation failure whose automatic rollback SUCCEEDS is not marked — the stack is back on its previous version', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-667-recovered-'));
		try {
			await withUpgradeEnv(homeDir, async () => {
				seedHome(homeDir);
				const docker = fakeDockerClient();
				const activateStackMock = mock(async () => ({
					ok: false,
					error: 'Container -assistant-1 Recreate',
					pullFailed: false
				}));
				// The automatic rollback's own reapply (reapplyRestoredStack) calls the
				// real `applyStack` directly — mock it to succeed so this scenario
				// represents a genuine recovery, not an artifact of no real Docker
				// daemon being present in the test environment.
				const applyStackMock = mock(async () => ({ ok: true }));
				mock.module('./docker.js', () => ({ ...realDocker, realDockerClient: docker, applyStack: applyStackMock }));
				mock.module('./activation.js', () => ({ ...realActivation, activateStack: activateStackMock }));

				const { performUpgrade, createState, isRollbackRecoveryFailure } = await import(
					`./lifecycle.js?rollback-recovered-test=${Math.random()}`
				);

				let caught: unknown;
				try {
					await performUpgrade(createState());
				} catch (error) {
					caught = error;
				}

				expect(caught).toBeInstanceOf(Error);
				expect(isRollbackRecoveryFailure(caught)).toBe(false);
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	test('a mutation failure whose automatic rollback reapply ALSO fails is marked — the stack is down', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-667-down-'));
		try {
			await withUpgradeEnv(homeDir, async () => {
				seedHome(homeDir);
				const docker = fakeDockerClient();
				const activateStackMock = mock(async () => ({
					ok: false,
					error: 'Container -assistant-1 Recreate',
					pullFailed: false
				}));
				// reapplyRestoredStack (lifecycle.ts) calls the real `applyStack` from
				// `./docker.js` directly — mock it to fail so the automatic rollback's
				// own reapply does not recover.
				const applyStackMock = mock(async () => ({ ok: false, error: 'simulated reapply failure' }));
				mock.module('./docker.js', () => ({ ...realDocker, realDockerClient: docker, applyStack: applyStackMock }));
				mock.module('./activation.js', () => ({ ...realActivation, activateStack: activateStackMock }));

				const { performUpgrade, createState, isRollbackRecoveryFailure } = await import(
					`./lifecycle.js?rollback-down-test=${Math.random()}`
				);

				let caught: unknown;
				try {
					await performUpgrade(createState());
				} catch (error) {
					caught = error;
				}

				expect(caught).toBeInstanceOf(Error);
				expect((caught as Error).message).toContain('did not fully recover');
				expect(isRollbackRecoveryFailure(caught)).toBe(true);
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});
