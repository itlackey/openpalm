import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';

import {
	applyImport,
	createBackup,
	createOpenPalmState,
	ensureRuntime,
	planImport,
	testAssistantReadiness
} from '../packages/lib/src/index.js';
import { bootstrapInstall } from '../packages/cli/src/commands/install.js';
import { main } from '../packages/cli/src/main.js';

const roots: string[] = [];
const originalHome = process.env.OP_HOME;
const originalRepo = process.env.OPENPALM_REPO_ROOT;
const taskHelper = join(import.meta.dir, '..', 'containers', 'assistant', 'openpalm-task.mjs');

afterEach(() => {
	if (originalHome === undefined) delete process.env.OP_HOME;
	else process.env.OP_HOME = originalHome;
	if (originalRepo === undefined) delete process.env.OPENPALM_REPO_ROOT;
	else process.env.OPENPALM_REPO_ROOT = originalRepo;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function digestTree(root: string): string {
	const files: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const directory = pending.pop();
		if (!directory) break;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile()) files.push(path);
		}
	}
	const hash = createHash('sha256');
	for (const file of files.sort()) {
		hash.update(relative(root, file));
		hash.update(readFileSync(file));
	}
	return hash.digest('hex');
}

function fakeReadinessFetch() {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		if (path === '/config') return Response.json({});
		if (path === '/session' && request.method === 'POST')
			return Response.json({ id: 'acceptance' });
		if (path === '/session/acceptance/message') {
			return Response.json({
				info: { providerID: 'test-provider', modelID: 'test-model' },
				parts: [{ type: 'text', text: 'OPENPALM_READY' }]
			});
		}
		if (path === '/session/acceptance' && request.method === 'DELETE') return Response.json(true);
		throw new Error(`Unexpected acceptance request: ${request.method} ${path}`);
	}) as typeof fetch;
}

function installFakeAkm(root: string): string {
	const bin = join(root, 'bin');
	mkdirSync(bin);
	const executable = join(bin, 'akm');
	writeFileSync(
		executable,
		`#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const knowledge = process.env.OPENPALM_KNOWLEDGE_DIR;
if (args[0] === 'task' && args[1] === 'add') {
  const id = args[2];
  const schedule = args[args.indexOf('--schedule') + 1];
  mkdirSync(join(knowledge, 'tasks'), { recursive: true });
  writeFileSync(join(knowledge, 'tasks', id + '.yml'), 'version: 4\\nname: ' + id + '\\nuses: akm/command\\nwith:\\n  content: scheduled\\nschedule: "' + schedule + '"\\n');
}
if (args[0] === 'task' && args[1] === 'run') {
  const id = args[2];
  const history = join(knowledge, '.akm', 'task-runs', id, 'run-1');
  mkdirSync(history, { recursive: true });
  writeFileSync(join(history, 'result.md'), 'durable scheduled result');
  mkdirSync(join(knowledge, 'inbox', id), { recursive: true });
  writeFileSync(join(knowledge, 'inbox', id, 'latest.md'), 'durable scheduled result');
}
`
	);
	chmodSync(executable, 0o755);
	return bin;
}

function task(home: string, bin: string, args: string[]) {
	return Bun.spawnSync({
		cmd: [process.execPath, taskHelper, ...args],
		env: {
			...process.env,
			PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
			OPENPALM_KNOWLEDGE_DIR: join(home, 'knowledge')
		},
		stdout: 'pipe',
		stderr: 'pipe'
	});
}

describe('0.14 deterministic control-plane integration', () => {
	it('wires installation, fixture readiness/tasks, file persistence, and safe restore', async () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-acceptance-'));
		roots.push(root);
		process.env.OPENPALM_REPO_ROOT = join(import.meta.dir, '..');
		const source = join(root, 'source');
		process.env.OP_HOME = source;
		await bootstrapInstall({ start: false });

		const readiness = await testAssistantReadiness(source, { fetch: fakeReadinessFetch() });
		expect(readiness).toMatchObject({
			ok: true,
			provider: 'test-provider',
			model: 'test-model'
		});

		mkdirSync(join(source, 'knowledge', 'notes'), { recursive: true });
		writeFileSync(
			join(source, 'knowledge', 'notes', 'project.md'),
			'Northstar is the active project.'
		);
		ensureRuntime(createOpenPalmState());
		ensureRuntime(createOpenPalmState());
		expect(readFileSync(join(source, 'knowledge', 'notes', 'project.md'), 'utf8')).toContain(
			'Northstar'
		);

		const bin = installFakeAkm(root);
		expect(
			task(source, bin, [
				'create',
				'project-news',
				'--schedule',
				'0 8 * * 1-5',
				'--prompt',
				'Check the news about Northstar'
			]).exitCode
		).toBe(0);
		expect(task(source, bin, ['run', 'project-news']).exitCode).toBe(0);
		expect(
			readFileSync(
				join(source, 'knowledge', '.akm', 'task-runs', 'project-news', 'run-1', 'result.md'),
				'utf8'
			)
		).toContain('durable scheduled result');

		await main(['credential', 'add', 'news-reader', 'read']);
		await main(['credential', 'map', 'discord', '123456789012345678', 'news-reader']);
		const backup = join(root, 'backup');
		await createBackup({ sourceHome: source, destination: backup, includePortalMaps: true });
		const sourceDigest = digestTree(backup);

		const destination = join(root, 'destination');
		process.env.OP_HOME = destination;
		await bootstrapInstall({ start: false });
		await main(['credential', 'add', 'news-reader', 'read']);
		const importOptions = {
			sourceHome: backup,
			destinationHome: destination,
			includePortalMaps: true
		};
		const preview = planImport(importOptions);
		expect(preview.conflicts).toBe(0);
		expect(preview.entries.some((entry) => entry.action === 'stage-task')).toBe(true);
		applyImport(importOptions);
		expect(digestTree(backup)).toBe(sourceDigest);
		expect(readFileSync(join(destination, 'knowledge', 'notes', 'project.md'), 'utf8')).toContain(
			'Northstar'
		);
		expect(existsSync(join(destination, 'knowledge', 'imported-tasks', 'project-news.yml'))).toBe(
			true
		);
	});
});
