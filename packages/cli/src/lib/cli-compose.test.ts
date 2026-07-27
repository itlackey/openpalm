import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { ControlPlaneState } from '@openpalm/lib';
import * as realLib from '../../../lib/src/index.ts';

const cliComposeModuleUrl = new URL('./cli-compose.ts', import.meta.url).href;

const fakeState = {
	homeDir: '/tmp/op-home',
	configDir: '/tmp/op-home/config',
	stashDir: '/tmp/op-home/knowledge',
	workspaceDir: '/tmp/op-home/workspace',
	dataDir: '/tmp/op-home/data',
	stackDir: '/tmp/op-home/system/stack',
	services: {},
	artifacts: { compose: '' },
	artifactMeta: []
} as unknown as ControlPlaneState;

const originalSkipEnv = process.env.OP_SKIP_COMPOSE_PREFLIGHT;

afterEach(() => {
	mock.restore();
	// mock.restore() does NOT undo mock.module() — re-point back to the real
	// module so this file's mocks don't leak into other test files sharing the
	// same `bun test` process.
	mock.module('@openpalm/lib', () => ({ ...realLib }));
	if (originalSkipEnv === undefined) delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
	else process.env.OP_SKIP_COMPOSE_PREFLIGHT = originalSkipEnv;
});

describe('runComposeWithPreflight — D1 docker-readiness preamble', () => {
	test('throws the friendly ensureDockerReady message when Docker is missing, before touching compose', async () => {
		delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
		let composePreflightCalled = false;
		let composeStreamingCalled = false;
		mock.module('@openpalm/lib', () => ({
			...realLib,
			runHomeMigrations: () => {},
			buildComposeOptions: () => ({ files: ['/tmp/fake.compose.yml'], envFiles: [], profiles: [] }),
			buildComposeCliArgs: () => [],
			ensureDockerReady: async () => ({
				ok: false,
				message:
					'Docker is not installed or not on your PATH. Install Docker (or set OP_DOCKER_BIN to a compatible binary), then retry.'
			}),
			composePreflight: async () => {
				composePreflightCalled = true;
				return { ok: true, stdout: '', stderr: '', code: 0 };
			},
			runComposeStreaming: async () => {
				composeStreamingCalled = true;
			}
		}));

		const { runComposeWithPreflight } = await import(`${cliComposeModuleUrl}?t=${Math.random()}`);
		await expect(runComposeWithPreflight(fakeState, ['up', '-d'])).rejects.toThrow(
			/Docker is not installed or not on your PATH/
		);
		expect(composePreflightCalled).toBe(false);
		expect(composeStreamingCalled).toBe(false);
	});

	test('OP_SKIP_COMPOSE_PREFLIGHT bypasses the docker-readiness preamble (existing tests stay green)', async () => {
		process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
		let ensureDockerReadyCalled = false;
		let composeStreamingCalled = false;
		mock.module('@openpalm/lib', () => ({
			...realLib,
			runHomeMigrations: () => {},
			buildComposeOptions: () => ({ files: ['/tmp/fake.compose.yml'], envFiles: [], profiles: [] }),
			buildComposeCliArgs: () => [],
			ensureDockerReady: async () => {
				ensureDockerReadyCalled = true;
				return { ok: false, message: 'should never be reached' };
			},
			composePreflight: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
			runComposeStreaming: async () => {
				composeStreamingCalled = true;
			}
		}));

		const { runComposeWithPreflight } = await import(`${cliComposeModuleUrl}?t=${Math.random()}`);
		await runComposeWithPreflight(fakeState, ['up', '-d']);

		expect(ensureDockerReadyCalled).toBe(false);
		expect(composeStreamingCalled).toBe(true);
	});

	test('a blank/ENOENT compose preflight stderr still surfaces a friendly, non-blank message', async () => {
		delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
		mock.module('@openpalm/lib', () => ({
			...realLib,
			runHomeMigrations: () => {},
			buildComposeOptions: () => ({ files: ['/tmp/fake.compose.yml'], envFiles: [], profiles: [] }),
			buildComposeCliArgs: () => [],
			// Docker looked ready at the preamble, but the compose invocation
			// itself hits a spawn-level failure with empty stderr (belt-and-
			// suspenders case the D1 fix must also cover).
			ensureDockerReady: async () => ({ ok: true as const }),
			composePreflight: async () => ({ ok: false, stdout: '', stderr: '', code: 1 }),
			runComposeStreaming: async () => {}
		}));

		const { runComposeWithPreflight } = await import(`${cliComposeModuleUrl}?t=${Math.random()}`);
		let thrown: Error | undefined;
		try {
			await runComposeWithPreflight(fakeState, ['up', '-d']);
		} catch (err) {
			thrown = err as Error;
		}

		expect(thrown).toBeDefined();
		expect(thrown?.message ?? '').not.toMatch(/Compose preflight failed: \n/);
		expect(thrown?.message ?? '').toContain('Docker reported an unknown error.');
	});
});
