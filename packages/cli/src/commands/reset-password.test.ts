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
