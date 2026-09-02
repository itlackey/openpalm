/**
 * Regression test for #639: a failed `performUpgrade` re-tags the running
 * images as `<namespace>/<service>:rollback-generation-<id>` and pins
 * `state/stack.env` to them (restoreRunningImageIds, image-snapshots.ts, run
 * as `performUpgrade`'s snapshot-rollback `preserveImages` callback). The
 * ONLY code that ever clears a `rollback-` pin, `advanceManagedImageVersions`,
 * runs earlier in the SAME attempt (applyManagedFiles, before activateStack)
 * — so on every repeated failure the sequence is unpin -> attempt -> fail ->
 * re-pin to a NEW generation. Before the fix there was no supported,
 * non-hand-editing way to break that cycle.
 *
 * This reproduces N (3) consecutive failed `performUpgrade` calls, asserts
 * the stack stays pinned to the Nth rollback generation the whole time (the
 * bug), then proves `clearRollbackPins` (the shared function behind
 * `openpalm unpin` and the admin UI's clear action) is a supported way off
 * the pin.
 *
 * `activateStack`/`applyStack` and the low-level `DockerClient` used by
 * captureRunningImageIds/restoreRunningImageIds are statically imported by
 * lifecycle.ts, so this test mocks them via `mock.module` and re-imports
 * lifecycle.ts with a cache-busting query — the same pattern used by
 * lifecycle-volume-reap.test.ts / lifecycle-install-ownership.test.ts.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realDocker from './docker.js';
import * as realActivation from './activation.js';
import { readVersions, SERVICE_VERSION_KEYS, clearRollbackPins } from './versions.js';

const realActivateStack = realActivation.activateStack;
const realDockerClient = realDocker.realDockerClient;

// mock.module() is NOT undone by mock.restore() and leaks across test files
// sharing this bun test process — always re-point back to the real
// implementation afterward (mirrors lifecycle-volume-reap.test.ts's comment).
afterEach(() => {
	mock.restore();
	mock.module('./docker.js', () => ({ ...realDocker, realDockerClient: realDockerClient }));
	mock.module('./activation.js', () => ({ ...realActivation, activateStack: realActivateStack }));
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

/** Container ids -> the running image each one reports, keyed by compose service. */
const RUNNING_CONTAINERS: Record<string, { image: string; service: string }> = {
	'cid-assistant': { image: 'openpalm/assistant:0.13.0', service: 'assistant' },
	'cid-guardian': { image: 'openpalm/guardian:0.13.0', service: 'guardian' },
	'cid-portal': { image: 'openpalm/portal:0.13.0', service: 'portal' }
};

/** A fake DockerClient standing in for the real `docker compose`/`docker inspect`/`docker image tag` calls. */
function fakeDockerClient() {
	return {
		run: mock(async (args: string[]) => {
			// `compose ... ps -q` — report one running container per core/managed service.
			if (args.includes('ps') && args.at(-1) === '-q') {
				return { ok: true, stdout: `${Object.keys(RUNNING_CONTAINERS).join('\n')}\n`, stderr: '', code: 0 };
			}
			// `docker inspect --format {{json .}} <id> <id> ...`
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
			// `docker image tag <id> <ref>` — the rollback re-tag itself.
			if (args[0] === 'image' && args[1] === 'tag') {
				return { ok: true, stdout: '', stderr: '', code: 0 };
			}
			return { ok: true, stdout: '', stderr: '', code: 0 };
		})
	};
}

describe('a repeatedly failing performUpgrade never releases its own rollback pin (#639)', () => {
	test('3 consecutive failed upgrades leave the stack pinned to the 3rd rollback generation, with no supported non-UI clear path before the fix', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-rollback-pin-'));
		try {
			await withUpgradeEnv(homeDir, async () => {
				const docker = fakeDockerClient();
				// Every attempt fails during activation (e.g. a bad image pull) —
				// pullFailed: true keeps containersMutated false, so no reapply of
				// the restored stack is attempted and no extra docker calls happen.
				const activateStackMock = mock(async () => ({
					ok: false,
					error: 'simulated activation failure',
					pullFailed: true
				}));

				mock.module('./docker.js', () => ({ ...realDocker, realDockerClient: docker }));
				mock.module('./activation.js', () => ({
					...realActivation,
					activateStack: activateStackMock
				}));

				const { performUpgrade, createState } = await import(
					`./lifecycle.js?rollback-pin-test=${Math.random()}`
				);

				const state = createState();
				const seenPins: string[] = [];

				for (let attempt = 1; attempt <= 3; attempt++) {
					await expect(performUpgrade(state)).rejects.toThrow();

					const versions = readVersions(state);
					for (const key of SERVICE_VERSION_KEYS) {
						if (key === 'OP_VOICE_VERSION') continue; // no running voice container in this fixture
						expect(versions[key]).toMatch(/^rollback-generation-/);
					}
					seenPins.push(versions.OP_ASSISTANT_VERSION);
				}

				expect(activateStackMock).toHaveBeenCalledTimes(3);
				// Each failure re-pins to a NEW generation — the bug: the pin never
				// clears itself, it just keeps moving forward.
				expect(new Set(seenPins).size).toBe(3);

				const stillPinnedAfterThreeFailures = readVersions(state).OP_ASSISTANT_VERSION;
				expect(stillPinnedAfterThreeFailures).toBe(seenPins[2]);

				// The fix: clearRollbackPins is the supported, non-hand-editing way
				// off the pin (backs both `openpalm unpin` and the admin UI action).
				const { cleared } = clearRollbackPins(state, '0.13.1');
				expect(cleared.OP_ASSISTANT_VERSION).toEqual({
					from: stillPinnedAfterThreeFailures,
					to: '0.13.1'
				});
				expect(cleared.OP_GUARDIAN_VERSION?.to).toBe('0.13.1');
				expect(cleared.OP_PORTAL_VERSION?.to).toBe('0.13.1');

				const clearedVersions = readVersions(state);
				for (const key of ['OP_ASSISTANT_VERSION', 'OP_GUARDIAN_VERSION', 'OP_PORTAL_VERSION'] as const) {
					expect(clearedVersions[key]).toBe('0.13.1');
					expect(clearedVersions[key]).not.toMatch(/^rollback-/);
				}

				const content = readFileSync(join(homeDir, 'state', 'stack.env'), 'utf-8');
				expect(content).not.toContain('rollback-generation-');
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});
