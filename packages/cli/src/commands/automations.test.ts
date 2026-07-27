/**
 * B5 — `automations check` must not shell out to `crontab` on Windows (no
 * crontab binary there); guard on process.platform before the execFile call.
 *
 * Harness: real @openpalm/lib + a seeded temp OP_HOME (matching
 * admin.test.ts's documented convention) rather than mocking
 * @openpalm/lib's resolveOpenPalmHome — that function is shared by many
 * files' imports, and other aggregate CLI test files use
 * mock.module('@openpalm/lib'), which can leak across files sharing this
 * bun test process. The mock is re-asserted at the START of every test
 * (not just in afterEach) for the same reason.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as nodeChildProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realLib from '../../../lib/src/index.ts';

const automationsModuleUrl = new URL('./automations.ts', import.meta.url).href;

const originalHome = process.env.OP_HOME;
let tempHome: string;
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function resetMocks(): void {
	mock.restore();
	mock.module('@openpalm/lib', () => ({ ...realLib }));
	mock.module('node:child_process', () => ({ ...nodeChildProcess }));
}

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), 'openpalm-automations-'));
	process.env.OP_HOME = tempHome;
	const tasksDir = join(tempHome, 'knowledge', 'tasks');
	mkdirSync(tasksDir, { recursive: true });
	writeFileSync(join(tasksDir, 'daily-digest.yml'), 'name: daily-digest\n');
});

afterEach(() => {
	mock.restore();
	mock.module('@openpalm/lib', () => ({ ...realLib }));
	mock.module('node:child_process', () => ({ ...nodeChildProcess }));
	setPlatform(originalPlatform);
	if (originalHome === undefined) delete process.env.OP_HOME;
	else process.env.OP_HOME = originalHome;
	rmSync(tempHome, { recursive: true, force: true });
});

describe('automationsCheck — B5 crontab platform guard', () => {
	test('on win32, prints a platform message and never shells out to crontab', async () => {
		resetMocks();
		setPlatform('win32');
		let execFileCalled = false;
		mock.module('node:child_process', () => ({
			...nodeChildProcess,
			execFile: (...args: unknown[]) => {
				execFileCalled = true;
				return (nodeChildProcess.execFile as unknown as (...a: unknown[]) => unknown)(...args);
			}
		}));

		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.map(String).join(' '));
		};

		try {
			const { automationsCheck } = await import(`${automationsModuleUrl}?t=${Math.random()}`);
			await automationsCheck();
		} finally {
			console.log = originalLog;
		}

		expect(execFileCalled).toBe(false);
		expect(logs.some((line) => /not available on Windows/i.test(line))).toBe(true);
	});

	test('on a non-Windows platform, still shells out to crontab', async () => {
		resetMocks();
		setPlatform('linux');
		let execFileCalled = false;
		mock.module('node:child_process', () => ({
			...nodeChildProcess,
			execFile: (
				_cmd: string,
				_cmdArgs: string[],
				callback: (error: Error | null, stdout: string, stderr: string) => void
			) => {
				execFileCalled = true;
				callback(new Error('ENOENT'), '', '');
			}
		}));

		const originalLog = console.log;
		console.log = () => {};
		try {
			const { automationsCheck } = await import(`${automationsModuleUrl}?t=${Math.random()}`);
			await automationsCheck();
		} finally {
			console.log = originalLog;
		}

		expect(execFileCalled).toBe(true);
	});
});
