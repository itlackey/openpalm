import { afterEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBackup } from './backup.js';
import { defaultStackConfig, writeStackConfig } from './stack-config.js';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
	const value = mkdtempSync(join(tmpdir(), 'openpalm-backup-test-'));
	roots.push(value);
	return value;
}

describe('portable backup', () => {
	it('copies only portable data by default and writes an integrity manifest', async () => {
		const source = join(root(), 'home');
		const destination = join(root(), 'backup');
		mkdirSync(join(source, 'knowledge', 'tasks'), { recursive: true });
		mkdirSync(join(source, 'knowledge', 'secrets'), { recursive: true });
		mkdirSync(join(source, 'workspace'), { recursive: true });
		mkdirSync(join(source, 'config', 'assistant'), { recursive: true });
		writeStackConfig(source, defaultStackConfig());
		writeFileSync(join(source, 'knowledge', 'notes.md'), 'durable knowledge');
		writeFileSync(join(source, 'knowledge', 'tasks', 'news.yaml'), 'schedule: "0 8 * * *"');
		writeFileSync(join(source, 'knowledge', 'secrets', 'auth.json'), '{"secret":true}');
		writeFileSync(join(source, 'workspace', 'project.txt'), 'workspace');
		writeFileSync(join(source, 'config', 'assistant', 'persona.md'), 'concise');

		const manifest = await createBackup({ sourceHome: source, destination });

		expect(manifest.files.map((entry) => entry.path)).toEqual([
			'config/assistant/persona.md',
			'knowledge/notes.md',
			'knowledge/tasks/news.yaml',
			'workspace/project.txt'
		]);
		expect(existsSync(join(destination, 'knowledge', 'secrets', 'auth.json'))).toBe(false);
		expect(JSON.parse(readFileSync(join(destination, 'openpalm-backup.json'), 'utf8'))).toEqual(
			manifest
		);
		expect(manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
	});

	it('includes provider auth only through explicit opt-in and refuses overwrite', async () => {
		const source = join(root(), 'home');
		const destination = join(root(), 'backup');
		mkdirSync(join(source, 'knowledge', 'secrets'), { recursive: true });
		writeStackConfig(source, defaultStackConfig());
		writeFileSync(join(source, 'knowledge', 'secrets', 'auth.json'), '{"provider":{}}');
		await createBackup({ sourceHome: source, destination, includeProviderAuth: true });
		expect(readFileSync(join(destination, 'knowledge', 'secrets', 'auth.json'), 'utf8')).toBe(
			'{"provider":{}}'
		);
		await expect(createBackup({ sourceHome: source, destination })).rejects.toThrow(
			'Backup destination must be empty'
		);
	});

	it('refuses a destination that resolves back inside the source through a parent symlink', async () => {
		if (process.platform === 'win32') return;
		const container = root();
		const source = join(container, 'home');
		mkdirSync(source);
		writeStackConfig(source, defaultStackConfig());
		const link = join(container, 'through-home');
		symlinkSync(source, link, 'dir');
		await expect(
			createBackup({ sourceHome: source, destination: join(link, 'nested-backup') })
		).rejects.toThrow('parent must be a real directory');
		expect(existsSync(join(source, 'nested-backup'))).toBe(false);
		mkdirSync(join(source, 'existing-backup'));
		await expect(
			createBackup({ sourceHome: source, destination: join(link, 'existing-backup') })
		).rejects.toThrow('must not resolve inside OP_HOME');
	});
});
