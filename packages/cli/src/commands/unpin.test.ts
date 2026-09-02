/**
 * #639 — `openpalm unpin` clears rollback-generation-* pins left behind by a
 * failed update via the shared clearRollbackPins() lib function, and never
 * touches a genuine operator pin.
 *
 * Harness: real @openpalm/lib + a seeded temp OP_HOME, mirroring
 * reset-password.test.ts's documented convention (mocking the shared
 * @openpalm/lib import can leak across files sharing this bun test process,
 * so the package/cli-state mocks are re-asserted at the START of every test).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realLib from '../../../lib/src/index.ts';
import * as realCliState from '../lib/cli-state.ts';

const cliStateModuleUrl = new URL('../lib/cli-state.ts', import.meta.url).href;
const unpinModuleUrl = new URL('./unpin.ts', import.meta.url).href;
const mainModuleUrl = new URL('../main.ts', import.meta.url).href;

const originalHome = process.env.OP_HOME;
let tempHome: string;

function resetMocks(): void {
	mock.restore();
	mock.module('@openpalm/lib', () => ({ ...realLib }));
	mock.module(cliStateModuleUrl, () => ({
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
}

function stackEnvPath(): string {
	return join(tempHome, 'state', 'stack.env');
}

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), 'openpalm-unpin-'));
	process.env.OP_HOME = tempHome;

	// Seed a minimal "installed" OP_HOME so ensureValidState() doesn't refuse.
	mkdirSync(join(tempHome, 'system', 'stack'), { recursive: true });
	writeFileSync(join(tempHome, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
	mkdirSync(join(tempHome, 'state'), { recursive: true });
});

afterEach(() => {
	mock.restore();
	mock.module('@openpalm/lib', () => ({ ...realLib }));
	mock.module(cliStateModuleUrl, () => ({ ...realCliState }));
	if (originalHome === undefined) delete process.env.OP_HOME;
	else process.env.OP_HOME = originalHome;
	rmSync(tempHome, { recursive: true, force: true });
});

describe('runUnpinAction (#639)', () => {
	test('clears the operator-reported stack.env shape: rollback- values with blank OP_MANAGED_* markers', async () => {
		writeFileSync(
			stackEnvPath(),
			[
				'OP_ASSISTANT_VERSION=rollback-generation-1788212586188-217761-1',
				'OP_VOICE_VERSION=rollback-generation-1788212586188-217761-1',
				'OP_GUARDIAN_VERSION=rollback-generation-1788212586188-217761-1',
				'OP_PORTAL_VERSION=rollback-generation-1788212586188-217761-1',
				'OP_MANAGED_ASSISTANT_VERSION=',
				'OP_MANAGED_GUARDIAN_VERSION=',
				'OP_MANAGED_PORTAL_VERSION=',
				'OP_MANAGED_VOICE_VERSION=',
				''
			].join('\n')
		);

		resetMocks();
		const { runUnpinAction } = await import(`${unpinModuleUrl}?t=${Math.random()}`);
		await runUnpinAction();

		const versions = realLib.readVersions(realLib.createState());
		expect(versions.OP_ASSISTANT_VERSION).toBe(realLib.PLATFORM_VERSION);
		expect(versions.OP_GUARDIAN_VERSION).toBe(realLib.PLATFORM_VERSION);
		expect(versions.OP_PORTAL_VERSION).toBe(realLib.PLATFORM_VERSION);
		expect(versions.OP_VOICE_VERSION).toBe('latest');
		for (const key of realLib.SERVICE_VERSION_KEYS) {
			expect(versions[key]).not.toMatch(/^rollback-/);
		}
	});

	test('never clears a genuine operator pin (no rollback- prefix), even with a blank managed marker', async () => {
		writeFileSync(
			stackEnvPath(),
			[
				'OP_ASSISTANT_VERSION=rollback-generation-1',
				'OP_GUARDIAN_VERSION=my-operator-pinned-build',
				'OP_MANAGED_ASSISTANT_VERSION=',
				'OP_MANAGED_GUARDIAN_VERSION=',
				''
			].join('\n')
		);

		resetMocks();
		const { runUnpinAction } = await import(`${unpinModuleUrl}?t=${Math.random()}`);
		await runUnpinAction();

		const content = readFileSync(stackEnvPath(), 'utf-8');
		expect(content).toContain('OP_GUARDIAN_VERSION=my-operator-pinned-build');
		expect(content).not.toContain('OP_ASSISTANT_VERSION=rollback-generation-1\n');
	});

	test('is a no-op (and says so) when nothing is pinned to a rollback generation', async () => {
		writeFileSync(stackEnvPath(), 'OP_ASSISTANT_VERSION=0.13.0\n');

		resetMocks();
		const { runUnpinAction } = await import(`${unpinModuleUrl}?t=${Math.random()}`);
		await runUnpinAction();

		const content = readFileSync(stackEnvPath(), 'utf-8');
		expect(content).toContain('OP_ASSISTANT_VERSION=0.13.0');
	});

	test('refuses on an OP_HOME with no install', async () => {
		rmSync(join(tempHome, 'system', 'stack', 'core.compose.yml'));

		resetMocks();
		const { runUnpinAction } = await import(`${unpinModuleUrl}?t=${Math.random()}`);
		await expect(runUnpinAction()).rejects.toThrow(/not installed/i);
	});
});

describe('unpin command registration', () => {
	test('is registered as a subcommand on the main CLI', async () => {
		resetMocks();
		const { mainCommand } = await import(`${mainModuleUrl}?t=${Math.random()}`);
		const sub = (mainCommand.subCommands as Record<string, () => Promise<unknown>>).unpin;
		expect(typeof sub).toBe('function');
		const cmd = (await sub()) as { meta?: { name?: string } };
		expect(cmd.meta?.name).toBe('unpin');
	});
});
