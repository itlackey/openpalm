/**
 * Regression test for #639: a failed `performUpgrade` re-tags the running
 * images as `<namespace>/<service>:rollback-generation-<id>` and pins
 * `state/stack.env` to them (restoreRunningImageIds, image-snapshots.ts, run
 * as `performUpgrade`'s snapshot-rollback `preserveImages` callback). The
 * ONLY code that ever clears a `rollback-` pin, `advanceManagedImageVersions`
 * (applyManagedFiles, called at the START of every upgrade attempt, before
 * activateStack), runs earlier in the SAME attempt — so on every repeated
 * failure the sequence is unpin -> attempt -> fail -> re-pin to a NEW
 * generation, and the pin survives exactly as long as updates keep failing.
 *
 * This reproduces N (3) consecutive failed `performUpgrade` calls and asserts
 * the stack stays pinned to the Nth rollback generation the whole time, then
 * proves the design is self-releasing: the very next `performUpgrade` whose
 * activation SUCCEEDS clears the pin on its own, with no manual step required.
 *
 * `activateStack`/`applyStack` and the low-level `DockerClient` used by
 * captureRunningImageIds/restoreRunningImageIds are statically imported by
 * lifecycle.ts, so this test mocks them via `mock.module` and re-imports
 * lifecycle.ts with a cache-busting query — the same pattern used by
 * lifecycle-volume-reap.test.ts / lifecycle-install-ownership.test.ts.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realDocker from './docker.js';
import * as realActivation from './activation.js';
import { readVersions, SERVICE_VERSION_KEYS, MANAGED_VERSION_MARKERS } from './versions.js';
import { PLATFORM_VERSION } from './versioning.js';

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

describe('a rollback-generation-* pin from a failed performUpgrade releases itself on the next successful update (#639)', () => {
	test('N consecutive failed upgrades stay pinned to the Nth rollback generation, and the next upgrade that activates successfully clears the pin with no manual step', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-rollback-pin-'));
		try {
			await withUpgradeEnv(homeDir, async () => {
				// An already-installed home, on the release these RUNNING_CONTAINERS
				// report, whose OP_MANAGED_* markers were never stamped (the shape a
				// home from before the managed-marker mechanism existed carries, and
				// the exact shape #639 was reported against). Seeded directly on
				// disk, not via ensureVersionDefaults, which only fills in a MISSING
				// key — it would not touch a marker sitting beside an already-defined
				// version key like this one.
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

				const docker = fakeDockerClient();
				// The first 3 attempts fail during activation (e.g. a bad image
				// pull) — pullFailed: true keeps containersMutated false, so no
				// reapply of the restored stack is attempted and no extra docker
				// calls happen. The 4th attempt succeeds, exactly like the failing
				// update finally landing a fix.
				let attempt = 0;
				const activateStackMock = mock(async () => {
					attempt += 1;
					if (attempt <= 3) {
						return { ok: false, error: 'simulated activation failure', pullFailed: true };
					}
					return { ok: true };
				});

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

				// (a) 3 consecutive failed upgrades leave state/stack.env pinned to
				// the Nth rollback-generation-* value, same as before the fix.
				for (let i = 1; i <= 3; i++) {
					await expect(performUpgrade(state)).rejects.toThrow();

					const versions = readVersions(state);
					for (const key of SERVICE_VERSION_KEYS) {
						if (key === 'OP_VOICE_VERSION') continue; // no running voice container in this fixture
						expect(versions[key]).toMatch(/^rollback-generation-/);
					}
					seenPins.push(versions.OP_ASSISTANT_VERSION);
				}

				expect(activateStackMock).toHaveBeenCalledTimes(3);
				// Each failure re-pins to a NEW generation — the pin keeps moving
				// forward, never clearing itself while updates keep failing.
				expect(new Set(seenPins).size).toBe(3);

				const stillPinnedAfterThreeFailures = readVersions(state).OP_ASSISTANT_VERSION;
				expect(stillPinnedAfterThreeFailures).toBe(seenPins[2]);

				// Every re-pinned key's OP_MANAGED_* marker is blank — restoreRunningImageIds
				// (the only writer of the rollback- value) never stamps it, and this
				// is the exact shape a genuine operator pin also leaves, which is why
				// the marker alone can never distinguish the two.
				const contentAfterFailures = readFileSync(join(homeDir, 'state', 'stack.env'), 'utf-8');
				for (const key of ['OP_ASSISTANT_VERSION', 'OP_GUARDIAN_VERSION', 'OP_PORTAL_VERSION'] as const) {
					const markerKey = MANAGED_VERSION_MARKERS[key];
					expect(contentAfterFailures).toMatch(new RegExp(`${markerKey}=(\\r?\\n|$)`));
				}

				// (b) The next performUpgrade activates successfully. advanceManagedImageVersions
				// (applyManagedFiles, before activateStack) clears the rollback- pin to the
				// target platform version on its own — no unpin command, no operator step.
				await performUpgrade(state);

				expect(activateStackMock).toHaveBeenCalledTimes(4);
				const clearedVersions = readVersions(state);
				for (const key of ['OP_ASSISTANT_VERSION', 'OP_GUARDIAN_VERSION', 'OP_PORTAL_VERSION'] as const) {
					expect(clearedVersions[key]).toBe(PLATFORM_VERSION);
					expect(clearedVersions[key]).not.toMatch(/^rollback-/);
				}

				const contentAfterSuccess = readFileSync(join(homeDir, 'state', 'stack.env'), 'utf-8');
				expect(contentAfterSuccess).not.toContain('rollback-generation-');
				// The marker is re-stamped to match (not left blank), so a later
				// release still recognizes these keys as managed and advances them.
				for (const key of ['OP_ASSISTANT_VERSION', 'OP_GUARDIAN_VERSION', 'OP_PORTAL_VERSION'] as const) {
					expect(contentAfterSuccess).toContain(`${MANAGED_VERSION_MARKERS[key]}=${PLATFORM_VERSION}`);
				}
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});

describe('performUpgrade pull policy follows the image tag', () => {
	// A dev tag is a local build no registry has; an explicit `compose pull`
	// can only fail. runDeploy already folds the fetch into `up` for that case
	// (deploy.ts isDevTag); performUpgrade must agree, or `openpalm update`
	// against a dev image dies at the pull step before touching the stack.
	for (const [tag, expectedPull] of [
		['dev', 'missing'],
		['0.13.0', 'always']
	] as const) {
		test(`a ${tag} tag requests pull:'${expectedPull}'`, async () => {
			const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-pull-policy-'));
			try {
				await withUpgradeEnv(homeDir, async () => {
					mkdirSync(join(homeDir, 'state'), { recursive: true });
					writeFileSync(
						join(homeDir, 'state', 'stack.env'),
						[
							`OP_ASSISTANT_VERSION=${tag}`,
							`OP_GUARDIAN_VERSION=${tag}`,
							`OP_PORTAL_VERSION=${tag}`,
							'OP_MANAGED_ASSISTANT_VERSION=',
							'OP_MANAGED_GUARDIAN_VERSION=',
							'OP_MANAGED_PORTAL_VERSION=',
							'OP_VOICE_VERSION=latest',
							'OP_MANAGED_VOICE_VERSION=latest',
							''
						].join('\n')
					);

					const docker = fakeDockerClient();
					const seen: Array<{ pull?: string } | undefined> = [];
					const activateStackMock = mock(async (_state: unknown, _scope: unknown, opts?: { pull?: string }) => {
						seen.push(opts);
						return { ok: true };
					});
					mock.module('./docker.js', () => ({ ...realDocker, realDockerClient: docker }));
					mock.module('./activation.js', () => ({ ...realActivation, activateStack: activateStackMock }));

					const { performUpgrade, createState } = await import(
						`./lifecycle.js?pull-policy-test=${Math.random()}`
					);
					await performUpgrade(createState());

					expect(seen).toHaveLength(1);
					expect(seen[0]?.pull).toBe(expectedPull);
				});
			} finally {
				rmSync(homeDir, { recursive: true, force: true });
			}
		});
	}
});
