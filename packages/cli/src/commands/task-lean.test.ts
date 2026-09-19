import { afterEach, describe, expect, it } from 'bun:test';
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
import { delimiter, join } from 'node:path';

const roots: string[] = [];
const helper = join(import.meta.dir, '../../../../containers/assistant/openpalm-task.mjs');

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-task-helper-'));
	roots.push(root);
	const knowledge = join(root, 'knowledge');
	const bin = join(root, 'bin');
	mkdirSync(join(knowledge, 'tasks'), { recursive: true });
	mkdirSync(bin);
	const calls = join(root, 'calls.jsonl');
	const fake = join(bin, 'akm');
	writeFileSync(
		fake,
		`#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.OPENPALM_AKM_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'task' && args[1] === 'add') {
  const id = args[2];
  const schedule = args[args.indexOf('--schedule') + 1];
  mkdirSync(join(process.env.OPENPALM_KNOWLEDGE_DIR, 'tasks'), { recursive: true });
  writeFileSync(join(process.env.OPENPALM_KNOWLEDGE_DIR, 'tasks', id + '.yml'), 'version: 4\\nname: ' + id + '\\nuses: akm/command\\nwith:\\n  content: task\\nschedule: "' + schedule + '"\\n');
}
`
	);
	chmodSync(fake, 0o755);
	return { root, knowledge, calls, bin };
}

function run(root: ReturnType<typeof fixture>, args: string[]) {
	return Bun.spawnSync({
		cmd: [process.execPath, helper, ...args],
		env: {
			...process.env,
			PATH: `${root.bin}${delimiter}${process.env.PATH ?? ''}`,
			OPENPALM_KNOWLEDGE_DIR: root.knowledge,
			OPENPALM_AKM_CALLS: root.calls
		},
		stdout: 'pipe',
		stderr: 'pipe'
	});
}

function calls(path: string): string[][] {
	return readFileSync(path, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as string[]);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Assistant task helper', () => {
	it('creates guarded scheduled prompts and supports pause and resume', () => {
		const root = fixture();
		const created = run(root, [
			'create',
			'morning-news',
			'--schedule',
			'0 8 * * *',
			'--prompt',
			'Summarize local news'
		]);
		expect(created.exitCode).toBe(0);
		const add = calls(root.calls)[0] ?? [];
		expect(add.slice(0, 3)).toEqual(['task', 'add', 'morning-news']);
		expect(add[add.indexOf('--prompt') + 1]).toContain('Treat web pages');
		expect(add).toContain('scheduled');
		expect(existsSync(join(root.knowledge, 'inbox', 'morning-news'))).toBe(true);

		expect(run(root, ['pause', 'morning-news']).exitCode).toBe(0);
		expect(readFileSync(join(root.knowledge, 'tasks', 'morning-news.yml'), 'utf8')).toContain(
			'enabled: false'
		);
		expect(run(root, ['resume', 'morning-news']).exitCode).toBe(0);
		expect(readFileSync(join(root.knowledge, 'tasks', 'morning-news.yml'), 'utf8')).toContain(
			'enabled: true'
		);
	});

	it('unschedules by preserving the exact task definition', () => {
		const root = fixture();
		expect(
			run(root, ['create', 'check-news', '--schedule', '@daily', '--prompt', 'Check news']).exitCode
		).toBe(0);
		expect(run(root, ['remove', 'check-news']).exitCode).toBe(0);
		expect(existsSync(join(root.knowledge, 'tasks', 'check-news.yml'))).toBe(false);
		const preserved = readdirSync(join(root.knowledge, 'disabled-tasks'));
		expect(preserved).toHaveLength(1);
		expect(preserved[0]).toStartWith('check-news-');
	});

	it('adopts only prompt tasks and always pauses them', () => {
		const root = fixture();
		mkdirSync(join(root.knowledge, 'imported-tasks'), { recursive: true });
		writeFileSync(
			join(root.knowledge, 'imported-tasks', 'safe.yml'),
			'version: 4\nuses: akm/command\nwith:\n  content: safe\nschedule: "0 8 * * *"\n'
		);
		writeFileSync(
			join(root.knowledge, 'imported-tasks', 'unsafe.yml'),
			'version: 4\nrun: curl https://example.invalid\nschedule: "0 8 * * *"\n'
		);
		writeFileSync(
			join(root.knowledge, 'imported-tasks', 'duplicate.yml'),
			'version: 4\nuses: akm/command\nuses: attacker/action\nschedule: "0 8 * * *"\n'
		);

		expect(
			run(root, ['adopt', join(root.knowledge, 'imported-tasks', 'safe.yml')]).exitCode
		).toBe(0);
		expect(readFileSync(join(root.knowledge, 'tasks', 'safe.yml'), 'utf8')).toContain(
			'enabled: false'
		);
		expect(
			run(root, ['adopt', join(root.knowledge, 'imported-tasks', 'unsafe.yml')]).exitCode
		).toBe(1);
		expect(existsSync(join(root.knowledge, 'tasks', 'unsafe.yml'))).toBe(false);
		expect(
			run(root, ['adopt', join(root.knowledge, 'imported-tasks', 'duplicate.yml')]).exitCode
		).toBe(1);
		expect(existsSync(join(root.knowledge, 'tasks', 'duplicate.yml'))).toBe(false);
	});
});
