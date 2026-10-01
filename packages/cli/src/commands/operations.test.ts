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

import {
	acquireStackLock,
	buildComposeOptions,
	composeConfigJson,
	createOpenPalmState,
	releaseStackLock
} from '@openpalm/lib';

import { main } from '../main.js';
import { diagnoseStack } from './doctor.js';
import { bootstrapInstall } from './install.js';
import { readStatus } from './lifecycle.js';
import { updateStack } from './update.js';

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
	await bootstrapInstall({ start: false });
	return home;
}

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-operations-command-'));
	roots.push(root);
	return root;
}

describe('operational command wiring', () => {
	it('enables add-ons and updates managed files without Docker', async () => {
		const root = fixture();
		const home = await install(root);
		await main(['addon', 'enable', 'gateway', '--no-apply']);
		await updateStack({ start: false });
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

	it('rejects invalid installation input without materializing a home', async () => {
		const root = fixture();
		process.env.OP_HOME = join(root, 'home');
		const configFile = join(root, 'invalid.json');
		writeFileSync(configFile, '{');
		await expect(bootstrapInstall({ start: false, configFile })).rejects.toThrow(
			'Invalid stack config JSON'
		);
		expect(existsSync(process.env.OP_HOME)).toBe(false);
		writeFileSync(configFile, JSON.stringify({ version: 999 }));
		await expect(bootstrapInstall({ start: false, configFile })).rejects.toThrow();
		expect(existsSync(process.env.OP_HOME)).toBe(false);
	});

	it('refuses concurrent updates before touching managed assets', async () => {
		const root = fixture();
		const home = await install(root);
		const managed = join(home, 'system', 'assistant', 'AGENTS.md');
		writeFileSync(managed, 'unchanged while lifecycle operation is active');
		const lock = acquireStackLock(join(home, 'data'));
		expect(lock).not.toBeNull();
		try {
			await expect(updateStack({ start: false })).rejects.toThrow('lifecycle_in_progress');
			expect(readFileSync(managed, 'utf8')).toBe('unchanged while lifecycle operation is active');
		} finally {
			releaseStackLock(lock);
		}
	});

	it('pulls and recreates on update, preserves user files, and allows local images', async () => {
		const root = fixture();
		const home = await install(root);
		const resolved = await composeConfigJson(buildComposeOptions(createOpenPalmState()));
		if (!resolved.ok) throw new Error(resolved.stderr);
		const fakeDocker = join(root, 'docker');
		const callsPath = join(root, 'docker-calls.jsonl');
		writeFileSync(
			fakeDocker,
			`#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
if (args.includes('config') && args.includes('--format')) console.log(${JSON.stringify(JSON.stringify(resolved.config))});
`
		);
		chmodSync(fakeDocker, 0o755);
		process.env.OP_DOCKER_BIN = fakeDocker;
		const knowledgeFile = join(home, 'knowledge', 'release-test.md');
		const configFile = join(home, 'config', 'assistant', 'persona.md');
		const credentialFile = join(home, 'state', 'credentials', 'owner', 'key');
		writeFileSync(knowledgeFile, 'user knowledge survives');
		writeFileSync(configFile, 'user persona survives');
		const credential = readFileSync(credentialFile);
		await updateStack({ start: true });
		await updateStack({ start: true, pull: false });
		const calls = readFileSync(callsPath, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as string[]);
		const updates = calls.filter((args) => args.includes('up'));
		expect(updates).toHaveLength(2);
		expect(updates[0]?.slice(-7)).toEqual([
			'up',
			'-d',
			'--pull',
			'always',
			'--force-recreate',
			'--remove-orphans',
			'--wait'
		]);
		expect(updates[1]).toContain('never');
		expect(readFileSync(knowledgeFile, 'utf8')).toBe('user knowledge survives');
		expect(readFileSync(configFile, 'utf8')).toBe('user persona survives');
		expect(readFileSync(credentialFile)).toEqual(credential);
		// This test resolves the real Compose configuration before using fake Docker.
		// Its subprocess budget is 30s; the default 5s test budget can cut it off on
		// a cold/contended runner before the assertions are reached.
	}, 30_000);

	it('reports Docker failures and reads status through an argument-safe fake Docker binary', async () => {
		const root = fixture();
		await install(root);
		process.env.OP_DOCKER_BIN = join(root, 'missing-docker');
		const diagnosis = await diagnoseStack();
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
