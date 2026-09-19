import { afterEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyHomeSeed } from './seed.js';
import { ensureHomeDirs } from './foundation.js';
import {
	classifyInstall,
	createOpenPalmState,
	ensureRuntime,
	markInstalled
} from './state.js';
import { readStackConfig } from './stack-config.js';

const roots: string[] = [];
const originalHome = process.env.OP_HOME;
const originalRepo = process.env.OPENPALM_REPO_ROOT;

afterEach(() => {
	if (originalHome === undefined) delete process.env.OP_HOME;
	else process.env.OP_HOME = originalHome;
	if (originalRepo === undefined) delete process.env.OPENPALM_REPO_ROOT;
	else process.env.OPENPALM_REPO_ROOT = originalRepo;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('0.14 clean install boundary', () => {
	it('refuses symlinked runtime directories instead of escaping OP_HOME', () => {
		if (process.platform === 'win32') return;
		const root = mkdtempSync(join(tmpdir(), 'openpalm-symlink-'));
		roots.push(root);
		const home = join(root, 'home');
		const outside = join(root, 'outside');
		mkdirSync(home);
		mkdirSync(outside);
		symlinkSync(outside, join(home, 'state'));
		expect(() => ensureHomeDirs(home)).toThrow('Refusing non-directory or symlink in OP_HOME');
	});

	it('refuses nested seed symlinks instead of writing managed files outside OP_HOME', async () => {
		if (process.platform === 'win32') return;
		const root = mkdtempSync(join(tmpdir(), 'openpalm-seed-symlink-'));
		roots.push(root);
		const home = join(root, 'home');
		const outside = join(root, 'outside');
		process.env.OPENPALM_REPO_ROOT = join(import.meta.dir, '../../../..');
		ensureHomeDirs(home);
		mkdirSync(outside);
		symlinkSync(outside, join(home, 'system', 'assistant', 'agents'));
		await expect(applyHomeSeed(home)).rejects.toThrow('symlink seed path');
		expect(existsSync(join(outside, 'remote.md'))).toBe(false);
	});

	it('classifies a nonempty unmanaged home as incompatible without mutating its files', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-migration-'));
		roots.push(root);
		const home = join(root, 'home');
		process.env.OP_HOME = home;
		process.env.OPENPALM_REPO_ROOT = join(import.meta.dir, '../../../..');
		mkdirSync(join(home, 'system', 'stack'), { recursive: true });
		mkdirSync(join(home, 'config', 'stack'), { recursive: true });
		mkdirSync(join(home, 'state'), { recursive: true });
		writeFileSync(join(home, 'system', 'stack', 'unmanaged.compose.yml'), 'unmanaged: true\n');
		writeFileSync(join(home, 'config', 'stack', 'custom.compose.yml'), 'user: sentinel\n');
		writeFileSync(
			join(home, 'state', 'stack.env'),
			'OP_UID=1000\nOP_GID=1000\nOP_SETUP_COMPLETE=true\nOP_ENABLED_ADDONS=gateway\n'
		);

		expect(classifyInstall(home)).toBe('incompatible_home');
		expect(readFileSync(join(home, 'system', 'stack', 'unmanaged.compose.yml'), 'utf8')).toBe(
			'unmanaged: true\n'
		);
		expect(readFileSync(join(home, 'config', 'stack', 'custom.compose.yml'), 'utf8')).toBe(
			'user: sentinel\n'
		);
		expect(existsSync(join(home, 'system', 'stack', 'stack.compose.yml'))).toBe(false);
		expect(readFileSync(join(home, 'state', 'stack.env'), 'utf8')).toContain('gateway');
	});

	it('materializes an empty home as a fresh setup without deleting operator data', async () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-fresh-'));
		roots.push(root);
		const home = join(root, 'home');
		process.env.OP_HOME = home;
		process.env.OPENPALM_REPO_ROOT = join(import.meta.dir, '../../../..');
		mkdirSync(home);
		writeFileSync(join(home, 'keep.txt'), 'operator data\n');
		expect(classifyInstall(home)).toBe('incompatible_home');

		rmSync(join(home, 'keep.txt'));
		expect(classifyInstall(home)).toBe('not_installed');
		await applyHomeSeed(home);
		const state = createOpenPalmState();
		ensureRuntime(state);
		expect(classifyInstall(home)).toBe('setup_incomplete');
		markInstalled(home);
		expect(classifyInstall(home)).toBe('installed');
		expect(readStackConfig(home).ok).toBe(true);
	});
});
