import { afterEach, describe, expect, it } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../main-lean.js';
import { diagnoseLeanStack } from './doctor-lean.js';
import { bootstrapLeanInstall } from './install-lean.js';
import { readStatus } from './lifecycle-lean.js';
import { updateLeanStack } from './update-lean.js';

const roots: string[] = [];
const originalHome = process.env.OP_HOME;
const originalRepo = process.env.OPENPALM_REPO_ROOT;
const originalDocker = process.env.OP_DOCKER_BIN;

afterEach(() => {
	if (originalHome === undefined) delete process.env.OP_HOME;
	else process.env.OP_HOME = originalHome;
	if (originalRepo === undefined) delete process.env.OPENPALM_REPO_ROOT;
	else process.env.OPENPALM_REPO_ROOT = originalRepo;
	if (originalDocker === undefined) delete process.env.OP_DOCKER_BIN;
	else process.env.OP_DOCKER_BIN = originalDocker;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function install(root: string): Promise<string> {
	const home = join(root, 'home');
	process.env.OP_HOME = home;
	process.env.OPENPALM_REPO_ROOT = join(import.meta.dir, '../../../..');
	await bootstrapLeanInstall({ start: false });
	return home;
}

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-operations-command-'));
	roots.push(root);
	return root;
}

describe('lean operational command wiring', () => {
	it('enables add-ons and updates managed files without Docker', async () => {
		const root = fixture();
		const home = await install(root);
		await main(['addon', 'enable', 'gateway', '--no-apply']);
		await updateLeanStack({ start: false });
		const config = JSON.parse(readFileSync(join(home, 'state', 'stack.json'), 'utf8')) as {
			gateway: { enabled: boolean };
		};
		expect(config.gateway.enabled).toBe(true);
		expect(existsSync(join(home, 'system', 'assistant', 'agents', 'remote-full.md'))).toBe(true);
	});

	it('previews and applies import through the CLI while leaving the source unchanged', async () => {
		const root = fixture();
		const source = join(root, 'old-home');
		mkdirSync(join(source, 'knowledge', 'notes'), { recursive: true });
		writeFileSync(join(source, 'knowledge', 'notes', 'portable.md'), 'portable');
		const home = await install(root);
		const before = readFileSync(join(source, 'knowledge', 'notes', 'portable.md'));
		await main(['import', '--from', source, '--dry-run', '--json']);
		await main(['import', '--from', source, '--apply', '--json']);
		expect(readFileSync(join(home, 'knowledge', 'notes', 'portable.md'), 'utf8')).toBe('portable');
		expect(readFileSync(join(source, 'knowledge', 'notes', 'portable.md'))).toEqual(before);
	});

	it('reports Docker failures and reads status through an argument-safe fake Docker binary', async () => {
		const root = fixture();
		await install(root);
		process.env.OP_DOCKER_BIN = join(root, 'missing-docker');
		const diagnosis = await diagnoseLeanStack();
		expect(diagnosis.checks.find((check) => check.name === 'docker')?.ok).toBe(false);

		const fakeDocker = join(root, 'docker');
		writeFileSync(
			fakeDocker,
			'#!/bin/sh\ncase " $* " in *" ps --format json "*) exit 0;; esac\nexit 1\n'
		);
		chmodSync(fakeDocker, 0o755);
		process.env.OP_DOCKER_BIN = fakeDocker;
		const status = await readStatus();
		expect(status.services).toEqual([]);
	});
});
