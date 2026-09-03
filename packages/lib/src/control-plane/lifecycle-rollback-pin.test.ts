/**
 * Regression test for #639, reworked for #679.
 *
 * A failed `performUpgrade` restores the images that were running before it, by
 * re-tagging where necessary and writing their REAL tags into `state/stack.env`
 * (restoreRunningImageIds, image-snapshots.ts, run as performUpgrade's
 * snapshot-rollback `preserveImages` callback). Those rows are ordinary pins:
 * the stack stays on the images that were working.
 *
 * WHAT CHANGED, AND WHY IT IS NOT A REGRESSION. It used to mint a synthetic
 * `rollback-generation-<id>` tag, which a later SUCCESSFUL update silently
 * cleared. That self-clearing depended on the update writing version rows —
 * the same write that, when it decided a value was "an operator pin", froze a
 * live instance on 0.13.1 for months while reporting success (#679). Updates no
 * longer write image tags at all, so the pin a rollback leaves is now cleared
 * by the operator, and `openpalm update` names it on every run until they do.
 * In exchange the value is a real, re-pullable release tag instead of a
 * local-only alias that accumulated orphan tags nothing reaped, and voice —
 * which the old self-clearing skipped unconditionally, so nothing EVER cleared
 * it — is no longer a special case.
 *
 * `activateStack`/`applyStack` and the low-level `DockerClient` used by
 * captureRunningImageIds/restoreRunningImageIds are statically imported by
 * lifecycle.ts, so this test mocks them via `mock.module` and re-imports
 * lifecycle.ts with a cache-busting query.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realDocker from './docker.js';
import * as realActivation from './activation.js';
import { readVersionPins, SERVICE_VERSION_KEYS } from './versions.js';
import { HOME_SCHEMA_VERSION } from './home.js';
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

describe('a failed performUpgrade restores the images that were running, as ordinary pins (#639/#679)', () => {
	test('N consecutive failed upgrades keep the stack on the images that were running, and a later successful upgrade does not silently move them', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-rollback-pin-'));
		try {
			await withUpgradeEnv(homeDir, async () => {
				mkdirSync(join(homeDir, 'state'), { recursive: true });
				writeFileSync(
					join(homeDir, 'state', 'stack.env'),
					[
						// An already-installed home with NO version rows: the normal
						// state now, where every image follows the tag the release
						// baked into its compose file.
						'OP_SETUP_COMPLETE=true',
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

				// (a) Three consecutive failed upgrades. Each one restores the
				// images that were running — the REAL 0.13.0 tags these
				// RUNNING_CONTAINERS report — as pins, so the stack stays on the
				// build that worked.
				for (let i = 1; i <= 3; i++) {
					await expect(performUpgrade(state)).rejects.toThrow();

					const pins = readVersionPins(state);
					for (const key of SERVICE_VERSION_KEYS) {
						if (key === 'OP_VOICE_VERSION') continue; // no running voice container in this fixture
						expect(pins[key]).toBe('0.13.0');
					}
				}

				expect(activateStackMock).toHaveBeenCalledTimes(3);

				// No synthetic tag is minted, so nothing accumulates orphan local
				// tags and no other call site has to recognise a magic prefix.
				const contentAfterFailures = readFileSync(join(homeDir, 'state', 'stack.env'), 'utf-8');
				expect(contentAfterFailures).not.toContain('rollback-generation-');

				// (b) The next performUpgrade activates successfully. On a home that
				// has not yet been through the v13->v14 migration — this one, and
				// every home upgrading INTO this release — the pins do not survive
				// it, and that is not an accident of the pin: `restoreSnapshot`
				// rolls `state/schema-version` back along with everything else, so
				// the retry re-runs the migration, which clears every version row.
				// Transition-only, self-limiting, and it lands on the behaviour an
				// operator retrying an upgrade wants. See the sibling test for the
				// steady state, where the pin does persist.
				await performUpgrade(state);

				expect(activateStackMock).toHaveBeenCalledTimes(4);
				expect(readVersionPins(state).OP_ASSISTANT_VERSION).toBeUndefined();

				const contentAfterSuccess = readFileSync(join(homeDir, 'state', 'stack.env'), 'utf-8');
				expect(contentAfterSuccess).not.toContain('OP_MANAGED_');
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	// The steady state, on a home already at the current schema: a rollback's
	// pins are ordinary pins, and a later successful update leaves them exactly
	// where they are. An update that moved them because it judged them
	// "release-managed" is what #679 was — the judgement was wrong, and nothing
	// said so for months.
	test('on a migrated home, the pins a failed upgrade leaves survive the next successful one', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-rollback-pin-steady-'));
		try {
			await withUpgradeEnv(homeDir, async () => {
				mkdirSync(join(homeDir, 'state'), { recursive: true });
				writeFileSync(join(homeDir, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
				writeFileSync(join(homeDir, 'state', 'schema-version'), `${HOME_SCHEMA_VERSION}\n`);

				const docker = fakeDockerClient();
				let attempt = 0;
				const activateStackMock = mock(async () => {
					attempt += 1;
					return attempt === 1
						? { ok: false, error: 'simulated activation failure', pullFailed: true }
						: { ok: true };
				});
				mock.module('./docker.js', () => ({ ...realDocker, realDockerClient: docker }));
				mock.module('./activation.js', () => ({ ...realActivation, activateStack: activateStackMock }));

				const { performUpgrade, createState } = await import(
					`./lifecycle.js?rollback-pin-steady-test=${Math.random()}`
				);
				const state = createState();

				await expect(performUpgrade(state)).rejects.toThrow();
				expect(readVersionPins(state).OP_ASSISTANT_VERSION).toBe('0.13.0');

				await performUpgrade(state);

				expect(readVersionPins(state).OP_ASSISTANT_VERSION).toBe('0.13.0');
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
