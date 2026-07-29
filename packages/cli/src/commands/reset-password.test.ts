/**
 * C3 — `openpalm reset-password` writes a new op_ui_login_password via the
 * existing patchSecretsEnvFile/writeSecret path and must NOT force a
 * container restart (no docker compose call at all).
 *
 * Harness: real @openpalm/lib + a seeded temp OP_HOME (matching
 * admin.test.ts's documented convention) rather than mocking
 * @openpalm/lib's resolve*Dir/secret functions — those are shared by many
 * files' imports, and other aggregate CLI test files use
 * mock.module('@openpalm/lib'), which can leak across files sharing this
 * bun test process. The package and cli-state mocks are re-asserted at the
 * START of every test (not just in afterEach) for the same reason.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realLib from '../../../lib/src/index.ts';
import * as realCliCompose from '../lib/cli-compose.ts';
import * as realCliState from '../lib/cli-state.ts';

const moduleUrls = {
	cliState: new URL('../lib/cli-state.ts', import.meta.url).href,
	cliCompose: new URL('../lib/cli-compose.ts', import.meta.url).href
};
const resetPasswordModuleUrl = new URL('./reset-password.ts', import.meta.url).href;
const mainModuleUrl = new URL('../main.ts', import.meta.url).href;

const originalHome = process.env.OP_HOME;
let tempHome: string;
let composeInvoked: boolean;

function resetMocks(): void {
	mock.restore();
	mock.module('@openpalm/lib', () => ({ ...realLib }));
	mock.module(moduleUrls.cliState, () => ({
		...realCliState,
		ensureValidState: () => {
			const state = realLib.createState();
			if (realLib.classifyLocalInstall(state.stackDir, state.homeDir) === 'not_installed') {
				throw new Error(
					'OpenPalm is not installed in this OP_HOME yet. Run `openpalm install` first.'
				);
			}
			state.artifacts = realLib.resolveRuntimeFiles();
			return state;
		}
	}));
	mock.module(moduleUrls.cliCompose, () => ({
		...realCliCompose,
		runComposeWithPreflight: async () => {
			composeInvoked = true;
		},
		runComposeReadOnly: async () => {
			composeInvoked = true;
		}
	}));
}

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), 'openpalm-reset-password-'));
	process.env.OP_HOME = tempHome;
	composeInvoked = false;

	// Seed a minimal "installed" OP_HOME so ensureValidState() doesn't refuse.
	mkdirSync(join(tempHome, 'system', 'stack'), { recursive: true });
	writeFileSync(join(tempHome, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
	mkdirSync(join(tempHome, 'state'), { recursive: true });
	writeFileSync(join(tempHome, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
});

afterEach(() => {
	mock.restore();
	mock.module('@openpalm/lib', () => ({ ...realLib }));
	mock.module(moduleUrls.cliState, () => ({ ...realCliState }));
	mock.module(moduleUrls.cliCompose, () => ({ ...realCliCompose }));
	if (originalHome === undefined) delete process.env.OP_HOME;
	else process.env.OP_HOME = originalHome;
	rmSync(tempHome, { recursive: true, force: true });
});

describe('runResetPasswordAction (C3)', () => {
	test('generates a random password, writes it to the secret file, and returns it', async () => {
		resetMocks();
		const { runResetPasswordAction } = await import(`${resetPasswordModuleUrl}?t=${Math.random()}`);
		const returned = await runResetPasswordAction();

		expect(returned.length).toBeGreaterThan(0);
		const onDisk = realLib.readSecret(tempHome, 'op_ui_login_password')?.trim();
		expect(onDisk).toBe(returned);
	});

	test('accepts an explicit password instead of generating one', async () => {
		resetMocks();
		const { runResetPasswordAction } = await import(`${resetPasswordModuleUrl}?t=${Math.random()}`);
		const returned = await runResetPasswordAction({ password: 'my-explicit-password' });

		expect(returned).toBe('my-explicit-password');
		expect(realLib.readSecret(tempHome, 'op_ui_login_password')?.trim()).toBe(
			'my-explicit-password'
		);
	});

	test('two resets produce different random passwords (no restart, no shared state)', async () => {
		resetMocks();
		const { runResetPasswordAction } = await import(`${resetPasswordModuleUrl}?t=${Math.random()}`);
		const first = await runResetPasswordAction();
		const second = await runResetPasswordAction();

		expect(first).not.toBe(second);
		expect(realLib.readSecret(tempHome, 'op_ui_login_password')?.trim()).toBe(second);
	});

	test('does not shell out to docker compose (no restart)', async () => {
		resetMocks();
		const { runResetPasswordAction } = await import(`${resetPasswordModuleUrl}?t=${Math.random()}`);
		await runResetPasswordAction();

		expect(composeInvoked).toBe(false);
	});
});

describe('module mock hygiene (regression guard)', () => {
	// Batch-introduced regression: this file's resetMocks() narrows
	// '../lib/cli-state.ts' down to { ensureValidState } and
	// '../lib/cli-compose.ts' down to a couple of stubs, with no spread of the
	// real module and no restoration of those two module URLs in afterEach.
	// mock.module registrations are keyed by resolved file path (not query
	// string) and persist in the shared module registry once
	// registered, so a later import of ui-server.ts can fail because the registry
	// entry never got its other exports back. This test exercises the narrow mock and then
	// relies on the real afterEach hook above (not a duplicate here) to prove
	// the registry is restored before the next test runs.
	test('exercises the narrow cli-state/cli-compose mocks', async () => {
		resetMocks();
		const { runResetPasswordAction } = await import(`${resetPasswordModuleUrl}?t=${Math.random()}`);
		await runResetPasswordAction();
	});

	test('a later import of ui-server.ts still resolves', async () => {
		// No resetMocks() here: this test relies solely on the afterEach hook
		// having restored the real cli-state.ts/cli-compose.ts modules after
		// the previous test's narrow mock.
		const uiServerModuleUrl = new URL('../lib/ui-server.ts', import.meta.url).href;
		const uiServer = await import(`${uiServerModuleUrl}?t=${Math.random()}`);
		expect(typeof uiServer.startUIServer).toBe('function');

		const cliState = await import(`${moduleUrls.cliState}?t=${Math.random()}`);
		expect(typeof cliState.resolveServeState).toBe('function');
		const cliCompose = await import(`${moduleUrls.cliCompose}?t=${Math.random()}`);
		expect(typeof cliCompose.runComposeWithPreflight).toBe('function');
		expect(typeof cliCompose.runComposeReadOnly).toBe('function');
	});
});

describe('reset-password command registration', () => {
	test('is registered as a subcommand on the main CLI', async () => {
		resetMocks();
		const { mainCommand } = await import(`${mainModuleUrl}?t=${Math.random()}`);
		const sub = (mainCommand.subCommands as Record<string, () => Promise<unknown>>)[
			'reset-password'
		];
		expect(typeof sub).toBe('function');
		const cmd = (await sub()) as { meta?: { name?: string } };
		expect(cmd.meta?.name).toBe('reset-password');
	});
});
