/**
 * Regression coverage for #664: a Compose activation refused BEFORE `mutate`
 * ever ran (the lock, `compose config` resolution, or the secret-boundary
 * audit) must be distinguishable from a genuine mutation attempt that failed
 * partway — and `performUpgrade`'s automatic-rollback wrapper must skip
 * re-tagging/re-pinning the running images on the former, since nothing was
 * ever deployed.
 *
 * Part 1 exercises `runComposeActivation` directly: a real secret-boundary
 * audit failure must (a) be tagged `isPreMutationRefusal`, and (b) never call
 * `mutate`. Fresh-imports `./activation.js` under a cache-busting query AFTER
 * mocking `./docker.js`'s `composeConfigJson`, so this module's own
 * `composeConfigJson` binding resolves against the mock (the same technique
 * lifecycle-rollback-pin.test.ts uses for `./lifecycle.js`).
 *
 * Part 2 exercises the actual bug shape end-to-end through `performUpgrade`:
 * a pre-mutation-refused activation must leave `state/stack.env`'s version
 * pins untouched (no `rollback-generation-*` re-pin) and must never call
 * `docker image tag`. Mocks `./activation.js` wholesale (like
 * lifecycle-rollback-pin.test.ts does) so the fake `activateStack` can throw
 * an error carrying the exact marker `runComposeActivation` would have set,
 * via the exported `markPreMutationRefusal` test seam.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realDocker from './docker.js';
import * as realActivation from './activation.js';
import { readVersions } from './versions.js';
import type { ControlPlaneState } from './types.js';

const realActivateStack = realActivation.activateStack;
const realDockerClient = realDocker.realDockerClient;
const realComposeConfigJson = realDocker.composeConfigJson;

afterEach(() => {
	mock.restore();
	mock.module('./docker.js', () => ({
		...realDocker,
		realDockerClient: realDockerClient,
		composeConfigJson: realComposeConfigJson
	}));
	mock.module('./activation.js', () => ({ ...realActivation, activateStack: realActivateStack }));
});

function makeState(home: string): ControlPlaneState {
	return {
		homeDir: home,
		configDir: join(home, 'config'),
		stashDir: join(home, 'knowledge'),
		workspaceDir: join(home, 'workspace'),
		dataDir: join(home, 'data'),
		stackDir: join(home, 'config', 'stack'),
		services: {},
		artifacts: { compose: '' },
		artifactMeta: []
	};
}

describe('runComposeActivation marks a pre-mutate refusal (#664)', () => {
	test('a genuine secret-boundary audit failure is tagged isPreMutationRefusal and never calls mutate', async () => {
		const home = mkdtempSync(join(tmpdir(), 'openpalm-premutation-'));
		try {
			mkdirSync(join(home, 'data'), { recursive: true });
			mkdirSync(join(home, 'knowledge', 'secrets'), { recursive: true, mode: 0o700 });
			mkdirSync(join(home, 'state', 'secrets'), { recursive: true, mode: 0o700 });
			writeFileSync(join(home, 'state', 'stack.env'), 'OP_ENABLED_ADDONS=\n');

			// A resolved compose config carrying a plaintext secret-like env var —
			// the exact `compose-secret-env-var` shape #664 was filed against.
			const badConfig = {
				services: {
					assistant: { environment: { LAB_API_KEY: 'super-secret' } }
				}
			};
			mock.module('./docker.js', () => ({
				...realDocker,
				composeConfigJson: async () => ({ ok: true, config: badConfig, stderr: '' })
			}));

			const { runComposeActivation, isPreMutationRefusal } = await import(
				`./activation.js?premutation-audit-test=${Math.random()}`
			);

			const state = makeState(home);
			const mutate = mock(async () => 'unreachable');

			let caught: unknown;
			try {
				await runComposeActivation(state, 'stack activation', mutate, {
					composeOptions: { files: [], envFiles: [], profiles: [] }
				});
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(Error);
			expect((caught as Error).message).toContain('secret-boundary audit failed');
			expect(isPreMutationRefusal(caught)).toBe(true);
			expect(mutate).not.toHaveBeenCalled();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('a successful activation calls mutate and never marks anything', async () => {
		const home = mkdtempSync(join(tmpdir(), 'openpalm-premutation-ok-'));
		try {
			mkdirSync(join(home, 'data'), { recursive: true });
			mkdirSync(join(home, 'knowledge', 'secrets'), { recursive: true, mode: 0o700 });
			mkdirSync(join(home, 'state', 'secrets'), { recursive: true, mode: 0o700 });
			writeFileSync(join(home, 'state', 'stack.env'), 'OP_ENABLED_ADDONS=\n');

			mock.module('./docker.js', () => ({
				...realDocker,
				composeConfigJson: async () => ({ ok: true, config: { services: {} }, stderr: '' })
			}));

			const { runComposeActivation } = await import(
				`./activation.js?premutation-ok-test=${Math.random()}`
			);

			const state = makeState(home);
			const mutate = mock(async () => 'ok');

			const result = await runComposeActivation(state, 'stack activation', mutate, {
				composeOptions: { files: [], envFiles: [], profiles: [] }
			});

			expect(result).toBe('ok');
			expect(mutate).toHaveBeenCalledTimes(1);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
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

/** Container ids -> the running image each one reports, keyed by compose service. */
const RUNNING_CONTAINERS: Record<string, { image: string; service: string }> = {
	'cid-assistant': { image: 'openpalm/assistant:0.13.0', service: 'assistant' },
	'cid-guardian': { image: 'openpalm/guardian:0.13.0', service: 'guardian' },
	'cid-portal': { image: 'openpalm/portal:0.13.0', service: 'portal' }
};

/** A fake DockerClient standing in for `docker compose ps`/`docker inspect`/`docker image tag`. */
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
			// `docker image tag <id> <ref>` — the rollback re-tag. Should NEVER be
			// reached by the pre-mutation-refusal scenario below.
			if (args[0] === 'image' && args[1] === 'tag') {
				return { ok: true, stdout: '', stderr: '', code: 0 };
			}
			return { ok: true, stdout: '', stderr: '', code: 0 };
		})
	};
}

describe('performUpgrade leaves version pins and running images untouched on a pre-mutation refusal (#664)', () => {
	test('a refusal before any Docker mutation does not re-pin state/stack.env or tag any image', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-664-'));
		try {
			await withUpgradeEnv(homeDir, async () => {
				mkdirSync(join(homeDir, 'state'), { recursive: true });
				const originalStackEnv = [
					'OP_ASSISTANT_VERSION=0.13.0',
					'OP_GUARDIAN_VERSION=0.13.0',
					'OP_PORTAL_VERSION=0.13.0',
					'OP_MANAGED_ASSISTANT_VERSION=',
					'OP_MANAGED_GUARDIAN_VERSION=',
					'OP_MANAGED_PORTAL_VERSION=',
					'OP_VOICE_VERSION=latest',
					'OP_MANAGED_VOICE_VERSION=latest',
					''
				].join('\n');
				writeFileSync(join(homeDir, 'state', 'stack.env'), originalStackEnv);

				const docker = fakeDockerClient();
				// Simulates runComposeActivation's own secret-boundary-audit refusal:
				// activateStack throws BEFORE any pull/up is attempted, exactly the
				// #664 shape ("no container is created, recreated, pulled, or
				// stopped"). markPreMutationRefusal is the same tag the real
				// runComposeActivation applies.
				const activateStackMock = mock(async () => {
					throw realActivation.markPreMutationRefusal(
						new Error(
							'Refusing Compose stack activation: secret-boundary audit failed.\ncompose-secret-env-var: service assistant environment key LAB_API_KEY is secret-like.'
						)
					);
				});

				mock.module('./docker.js', () => ({ ...realDocker, realDockerClient: docker }));
				mock.module('./activation.js', () => ({ ...realActivation, activateStack: activateStackMock }));

				const { performUpgrade, createState } = await import(
					`./lifecycle.js?premutation-664-test=${Math.random()}`
				);

				const state = createState();
				await expect(performUpgrade(state)).rejects.toThrow(/secret-boundary audit failed/);

				// The refusal must leave version pins exactly as they were — no
				// synthetic rollback-generation-* re-pin for a deploy that never
				// touched a container.
				const versions = readVersions(state);
				expect(versions.OP_ASSISTANT_VERSION).toBe('0.13.0');
				expect(versions.OP_GUARDIAN_VERSION).toBe('0.13.0');
				expect(versions.OP_PORTAL_VERSION).toBe('0.13.0');

				const content = readFileSync(join(homeDir, 'state', 'stack.env'), 'utf-8');
				expect(content).not.toContain('rollback-generation-');

				// The immutable-tag preservation step (the only caller of `docker
				// image tag`) must never run when nothing was mutated.
				const imageTagCalls = docker.run.mock.calls.filter(
					(call) => Array.isArray(call[0]) && call[0][0] === 'image' && call[0][1] === 'tag'
				);
				expect(imageTagCalls).toHaveLength(0);
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});
