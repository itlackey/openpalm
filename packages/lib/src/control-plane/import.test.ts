import { afterEach, describe, expect, it } from 'bun:test';
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBackup } from './backup.js';
import { applyImport, planImport } from './import.js';
import { managedComposeFile } from './foundation.js';
import { defaultStackConfig, writeStackConfig } from './stack-config.js';

const roots: string[] = [];

function fixture(): { root: string; source: string; destination: string } {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-import-'));
	roots.push(root);
	const source = join(root, 'old');
	const destination = join(root, 'fresh');
	mkdirSync(source);
	mkdirSync(join(destination, 'system', 'stack'), { recursive: true });
	writeFileSync(managedComposeFile(destination), 'services: {}\n');
	writeStackConfig(destination, defaultStackConfig());
	return { root, source, destination };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('0.14 fresh-install importer', () => {
	it('copies knowledge and binary workspace files while staging tasks disabled', () => {
		const { source, destination } = fixture();
		mkdirSync(join(source, 'knowledge', 'notes'), { recursive: true });
		mkdirSync(join(source, 'knowledge', 'tasks'), { recursive: true });
		mkdirSync(join(source, 'knowledge', 'secrets'), { recursive: true });
		mkdirSync(join(source, 'workspace'), { recursive: true });
		writeFileSync(join(source, 'knowledge', 'notes', 'person.md'), 'remember me\n');
		writeFileSync(
			join(source, 'knowledge', 'tasks', 'news.yml'),
			'version: 4\nname: news\nuses: akm/command\nwith:\n  content: news\nschedule:\n  - cron: "0 8 * * *"\n    enabled: true\n'
		);
		writeFileSync(join(source, 'knowledge', 'secrets', 'auth.json'), '{"secret":true}\n');
		writeFileSync(join(source, 'workspace', 'image.bin'), Buffer.from([0, 255, 1, 2]));
		writeFileSync(join(source, 'workspace', 'tool.sh'), '#!/bin/sh\nexit 0\n');
		chmodSync(join(source, 'workspace', 'tool.sh'), 0o755);

		const plan = planImport({ sourceHome: source, destinationHome: destination });
		expect(plan.conflicts).toBe(0);
		expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(plan.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
		expect(plan.entries.map((entry) => [entry.relativeDestination, entry.action])).toContainEqual([
			'knowledge/imported-tasks/news.yml',
			'stage-task'
		]);
		expect(plan.entries.some((entry) => entry.relativeSource.includes('secrets/auth.json'))).toBe(
			false
		);

		applyImport({ sourceHome: source, destinationHome: destination });
		expect(readFileSync(join(destination, 'knowledge', 'notes', 'person.md'), 'utf8')).toBe(
			'remember me\n'
		);
		expect(readFileSync(join(destination, 'workspace', 'image.bin'))).toEqual(
			Buffer.from([0, 255, 1, 2])
		);
		expect(lstatSync(join(destination, 'workspace', 'tool.sh')).mode & 0o777).toBe(0o700);
		expect(existsSync(join(destination, 'knowledge', 'tasks', 'news.yml'))).toBe(false);
		expect(existsSync(join(destination, 'knowledge', 'imported-tasks', 'news.yml'))).toBe(true);
	});

	it('binds apply to the exact source content reviewed in a preview', () => {
		const { source, destination } = fixture();
		mkdirSync(join(source, 'knowledge'), { recursive: true });
		const path = join(source, 'knowledge', 'memory.md');
		writeFileSync(path, 'reviewed value\n');
		const preview = planImport({ sourceHome: source, destinationHome: destination });
		writeFileSync(path, 'changed! value\n');

		expect(() =>
			applyImport({ sourceHome: source, destinationHome: destination }, preview.digest)
		).toThrow('changed after preview');
		expect(existsSync(join(destination, 'knowledge', 'memory.md'))).toBe(false);
	});

	it('refuses conflicts and never follows source symlinks', () => {
		if (process.platform === 'win32') return;
		const { root, source, destination } = fixture();
		mkdirSync(join(source, 'knowledge'), { recursive: true });
		mkdirSync(join(destination, 'knowledge'), { recursive: true });
		writeFileSync(join(source, 'knowledge', 'conflict.md'), 'old\n');
		writeFileSync(join(destination, 'knowledge', 'conflict.md'), 'new\n');
		writeFileSync(join(root, 'outside'), 'outside\n');
		symlinkSync(join(root, 'outside'), join(source, 'knowledge', 'escape.md'));

		const plan = planImport({ sourceHome: source, destinationHome: destination });
		expect(plan.conflicts).toBe(1);
		expect(plan.warnings.some((warning) => warning.includes('escape.md'))).toBe(true);
		expect(() => applyImport({ sourceHome: source, destinationHome: destination })).toThrow(
			'destination conflict'
		);
		expect(readFileSync(join(destination, 'knowledge', 'conflict.md'), 'utf8')).toBe('new\n');
	});

	it('validates imported portal identities against the new credential registry', () => {
		const { source, destination } = fixture();
		mkdirSync(join(source, 'config', 'portal', 'discord'), { recursive: true });
		writeFileSync(
			join(source, 'config', 'portal', 'discord', 'credentials.json'),
			JSON.stringify({ version: 1, users: { '12345': 'missing' } })
		);
		expect(() =>
			planImport({
				sourceHome: source,
				destinationHome: destination,
				includePortalMaps: true
			})
		).toThrow('recreate it before import');
	});

	it('verifies a portable backup manifest before planning its restore', async () => {
		const { root, destination } = fixture();
		const live = join(root, 'live-home');
		const backup = join(root, 'backup');
		mkdirSync(join(live, 'knowledge'), { recursive: true });
		writeStackConfig(live, defaultStackConfig());
		writeFileSync(join(live, 'knowledge', 'memory.md'), 'remember this');
		await createBackup({ sourceHome: live, destination: backup });
		expect(planImport({ sourceHome: backup, destinationHome: destination }).conflicts).toBe(0);
		writeFileSync(join(backup, 'knowledge', 'memory.md'), 'tampered data');
		expect(() => planImport({ sourceHome: backup, destinationHome: destination })).toThrow(
			'Backup checksum mismatch'
		);
	});
});
