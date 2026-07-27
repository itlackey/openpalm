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
import * as realCliCompose from '../lib/cli-compose.ts';
import * as realCliState from '../lib/cli-state.ts';

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
	mock.module(moduleUrls.cliState, () => ({ ...realCliState }));
	mock.module(moduleUrls.cliCompose, () => ({ ...realCliCompose }));
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

describe('module mock hygiene (regression guard)', () => {
	// Batch-introduced regression: this file's resetMocks() narrows
	// '../lib/cli-state.ts' down to { ensureValidState } and
	// '../lib/cli-compose.ts' down to { runComposeWithPreflight }, with no
	// spread of the real module and no restoration of those two module URLs in
	// afterEach. mock.module registrations are keyed by resolved file path
	// (not query string) and persist in the shared module registry once
	// registered — a later file's plain `import { migrateBestEffort } from
	// './cli-state.ts'` (ui-server.ts:20) then throws "SyntaxError: Export
	// named migrateBestEffort not found" because the registry entry never got
	// its other exports back. This test exercises the narrow mock and then
	// relies on the real afterEach hook above (not a duplicate here) to prove
	// the registry is restored before the next test runs.
	test('exercises the narrow cli-state/cli-compose mocks', () => {
		seedInstalledHome(tempHome);
		resetMocks();
	});

	test('a later import of ui-server.ts (static `migrateBestEffort` import) still resolves', async () => {
		// No resetMocks() here: this test relies solely on the afterEach hook
		// having restored the real cli-state.ts/cli-compose.ts modules after
		// the previous test's narrow mock.
		const uiServerModuleUrl = new URL('../lib/ui-server.ts', import.meta.url).href;
		const uiServer = await import(`${uiServerModuleUrl}?t=${Math.random()}`);
		expect(typeof uiServer.startUIServer).toBe('function');

		const cliState = await import(`${moduleUrls.cliState}?t=${Math.random()}`);
		expect(typeof cliState.migrateBestEffort).toBe('function');
		expect(typeof cliState.resolveServeState).toBe('function');
		const cliCompose = await import(`${moduleUrls.cliCompose}?t=${Math.random()}`);
		expect(typeof cliCompose.runComposeWithPreflight).toBe('function');
		expect(typeof cliCompose.runComposeReadOnly).toBe('function');
	});
});
