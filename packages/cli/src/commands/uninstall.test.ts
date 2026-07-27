/**
 * C1 — `uninstall --purge` must remove state/ and system/ (in addition to
 * config/knowledge/workspace/data) so a subsequent plain `install` is not
 * blocked by a survivor state/stack.env or system/stack/core.compose.yml.
 *
 * Harness: real @openpalm/lib + a seeded temp OP_HOME (matching
 * admin.test.ts's documented convention) rather than mocking
 * @openpalm/lib's resolve*Dir functions — those are shared by many files'
 * imports, and other aggregate CLI test files use mock.module('@openpalm/lib'),
 * which can leak across files sharing this bun test process. The package
 * and cli-state mocks are re-asserted at the START of every test (not just
 * in afterEach) for the same reason.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realLib from '../../../lib/src/index.ts';

const moduleUrls = {
	cliState: new URL('../lib/cli-state.ts', import.meta.url).href,
	cliCompose: new URL('../lib/cli-compose.ts', import.meta.url).href
};
const uninstallModuleUrl = new URL('./uninstall.ts', import.meta.url).href;

const originalHome = process.env.OP_HOME;
let tempHome: string;
let composeCalls: string[][];

function resetMocks(): void {
	mock.restore();
	mock.module('@openpalm/lib', () => ({
		...realLib,
		// Stub the install lock (matching start.test.ts/repair-ownership.test.ts
		// convention): the real fs-based lock is process-pid-keyed, and OTHER
		// test files in this bun test process also mock acquireInstallLock (e.g.
		// to simulate a held lock) — sharing the single '@openpalm/lib' module
		// registry across files means this test must not depend on the real
		// implementation's runtime state. This test is about the purge dir
		// list, not lock acquisition semantics (covered elsewhere).
		acquireInstallLock: () => ({ path: '/tmp/fake-uninstall-test.install.lock' }),
		releaseInstallLock: () => {}
	}));
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
		runComposeWithPreflight: async (_state: unknown, subArgs: string[]) => {
			composeCalls.push(subArgs);
		}
	}));
}

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), 'openpalm-uninstall-'));
	process.env.OP_HOME = tempHome;
	composeCalls = [];
});

afterEach(() => {
	mock.restore();
	mock.module('@openpalm/lib', () => ({ ...realLib }));
	if (originalHome === undefined) delete process.env.OP_HOME;
	else process.env.OP_HOME = originalHome;
	rmSync(tempHome, { recursive: true, force: true });
});

/** Seed a minimal OP_HOME layout under `home` that classifies as "installed". */
function seedInstalledHome(home: string): void {
	mkdirSync(join(home, 'system', 'stack'), { recursive: true });
	writeFileSync(join(home, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
	mkdirSync(join(home, 'state'), { recursive: true });
	writeFileSync(join(home, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
	mkdirSync(join(home, 'config'), { recursive: true });
	mkdirSync(join(home, 'knowledge'), { recursive: true });
	mkdirSync(join(home, 'workspace'), { recursive: true });
	mkdirSync(join(home, 'data'), { recursive: true });
}

describe('runUninstallAction --purge (C1)', () => {
	test('removes state/ and system/, and a subsequent install predicate is no longer blocked', async () => {
		seedInstalledHome(tempHome);
		resetMocks();

		const { runUninstallAction } = await import(`${uninstallModuleUrl}?t=${Math.random()}`);
		await runUninstallAction({ purge: true });

		expect(existsSync(join(tempHome, 'state'))).toBe(false);
		expect(existsSync(join(tempHome, 'system'))).toBe(false);
		expect(existsSync(join(tempHome, 'config'))).toBe(false);
		expect(existsSync(join(tempHome, 'knowledge'))).toBe(false);
		expect(existsSync(join(tempHome, 'workspace'))).toBe(false);
		expect(existsSync(join(tempHome, 'data'))).toBe(false);

		// The next plain `install` must not see this as an existing install.
		expect(realLib.classifyLocalInstall(join(tempHome, 'system', 'stack'), tempHome)).toBe(
			'not_installed'
		);
	});

	test('without --purge, config/data survive and only compose down runs', async () => {
		seedInstalledHome(tempHome);
		resetMocks();

		const { runUninstallAction } = await import(`${uninstallModuleUrl}?t=${Math.random()}`);
		await runUninstallAction({});

		expect(composeCalls).toEqual([['down']]);
		expect(existsSync(join(tempHome, 'state'))).toBe(true);
		expect(existsSync(join(tempHome, 'system'))).toBe(true);
		expect(existsSync(join(tempHome, 'data'))).toBe(true);
	});
});
