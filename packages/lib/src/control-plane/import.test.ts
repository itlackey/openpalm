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

function providerConfiguration(source: string, apiKey: string): void {
	mkdirSync(join(source, 'config', 'assistant'), { recursive: true });
	writeFileSync(
		join(source, 'config', 'assistant', 'opencode.json'),
		JSON.stringify({
			provider: { personal: { options: { apiKey } } }
		})
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('0.14 fresh-install importer', () => {
	it('never stages historical AKM configuration or prior unsafe staging into searchable knowledge', () => {
		const { source, destination } = fixture();
		for (const path of ['config/akm', 'knowledge/imported-config/akm']) {
			mkdirSync(join(source, path), { recursive: true });
			writeFileSync(join(source, path, 'config.json'), '{"token":"do-not-copy"}');
		}
		const plan = applyImport({
			sourceHome: source,
			destinationHome: destination,
			includeProviderAuth: true
		});
		expect(plan.entries).toHaveLength(0);
		expect(plan.warnings.filter((warning) => warning.includes('historical AKM'))).toHaveLength(2);
		expect(JSON.stringify(plan)).not.toContain('do-not-copy');
		expect(existsSync(join(destination, 'knowledge', 'imported-config', 'akm'))).toBe(false);
		expect(readFileSync(join(source, 'config', 'akm', 'config.json'), 'utf8')).toContain(
			'do-not-copy'
		);
	});

	it('prunes generated dependency trees before traversal while preserving authored files', () => {
		const { source, destination } = fixture();
		for (const base of ['workspace/project', 'knowledge/projects/project']) {
			mkdirSync(join(source, base, 'node_modules', 'dependency'), { recursive: true });
			writeFileSync(join(source, base, 'README.md'), 'authored project');
			writeFileSync(
				join(source, base, 'node_modules', 'dependency', 'secret.env'),
				'not knowledge'
			);
			if (process.platform !== 'win32')
				symlinkSync('/outside', join(source, base, 'node_modules', 'link'));
		}
		const plan = applyImport({ sourceHome: source, destinationHome: destination });
		expect(plan.entries).toHaveLength(2);
		expect(
			plan.warnings.filter((warning) => warning.includes('generated dependencies'))
		).toHaveLength(2);
		expect(plan.warnings.some((warning) => warning.includes('Skipped symlink'))).toBe(false);
		expect(existsSync(join(destination, 'workspace', 'project', 'node_modules'))).toBe(false);
		expect(
			existsSync(join(source, 'workspace', 'project', 'node_modules', 'dependency', 'secret.env'))
		).toBe(true);
	});

	it('regenerates known AKM metadata rather than importing old indexes or runtime state', () => {
		const { source, destination } = fixture();
		mkdirSync(join(source, 'knowledge', '.akm'), { recursive: true });
		writeFileSync(join(source, 'knowledge', '.akm', 'state.db'), 'stale private runtime state');
		writeFileSync(join(source, 'knowledge', 'authored.md'), 'keep authored knowledge');
		const plan = applyImport({ sourceHome: source, destinationHome: destination });
		expect(plan.entries.map((entry) => entry.relativeDestination)).toEqual([
			'knowledge/authored.md'
		]);
		expect(plan.warnings.join('\n')).toContain('regenerates its indexes');
		expect(existsSync(join(source, 'knowledge', '.akm', 'state.db'))).toBe(true);
		expect(existsSync(join(destination, 'knowledge', '.akm'))).toBe(false);
	});

	it('imports native referenced provider files only with explicit opt-in and private permissions', () => {
		const { source, destination } = fixture();
		providerConfiguration(source, '{file:/stash/secrets/providers/personal.key}');
		mkdirSync(join(source, 'knowledge', 'secrets', 'providers'), { recursive: true });
		writeFileSync(
			join(source, 'knowledge', 'secrets', 'providers', 'personal.key'),
			'private-provider-key'
		);
		chmodSync(join(source, 'knowledge', 'secrets', 'providers', 'personal.key'), 0o755);
		writeFileSync(
			join(source, 'knowledge', 'secrets', 'auth.json'),
			'{"personal":{"type":"api","key":"auth-key"}}'
		);
		writeFileSync(join(source, 'knowledge', 'secrets', 'unrelated.key'), 'not-approved');
		const excluded = planImport({ sourceHome: source, destinationHome: destination });
		expect(excluded.entries.some((entry) => entry.category === 'secret')).toBe(false);
		expect(excluded.warnings.join('\n')).toContain('--include-provider-auth');
		const plan = applyImport({
			sourceHome: source,
			destinationHome: destination,
			includeProviderAuth: true
		});
		expect(plan.entries.filter((entry) => entry.category === 'secret')).toHaveLength(2);
		expect(JSON.stringify(plan)).not.toContain('private-provider-key');
		expect(JSON.stringify(plan)).not.toContain('auth-key');
		const key = join(destination, 'knowledge', 'secrets', 'providers', 'personal.key');
		expect(readFileSync(key, 'utf8')).toBe('private-provider-key');
		if (process.platform !== 'win32') expect(lstatSync(key).mode & 0o777).toBe(0o600);
		expect(existsSync(join(destination, 'knowledge', 'secrets', 'unrelated.key'))).toBe(false);
	});

	it('imports explicitly approved user environment files as private non-executable data', () => {
		const { source, destination } = fixture();
		mkdirSync(join(source, 'knowledge', 'env'), { recursive: true });
		writeFileSync(join(source, 'knowledge', 'env', 'user.env'), 'PRIVATE_USER_VALUE=do-not-log\n');
		chmodSync(join(source, 'knowledge', 'env', 'user.env'), 0o755);
		const plan = applyImport({
			sourceHome: source,
			destinationHome: destination,
			includeUserEnv: true
		});
		if (process.platform !== 'win32')
			expect(lstatSync(join(destination, 'knowledge', 'env', 'user.env')).mode & 0o777).toBe(0o600);
		expect(JSON.stringify(plan)).not.toContain('do-not-log');
	});

	it.each(['remote-mcp', 'local-mcp', 'plugin'])(
		'never imports non-portable %s configuration, with or without provider opt-in',
		(kind) => {
			for (const includeProviderAuth of [false, true]) {
				const { source, destination } = fixture();
				mkdirSync(join(source, 'config', 'assistant'), { recursive: true });
				const setting =
					kind === 'remote-mcp'
						? {
								mcp: {
									private: {
										type: 'remote',
										url: 'https://example.invalid/mcp',
										headers: { Authorization: 'Bearer unrelated-mcp-key' }
									}
								}
							}
						: kind === 'local-mcp'
							? {
									mcp: {
										private: {
											type: 'local',
											command: ['private-tool'],
											environment: { PRIVATE_KEY: 'unrelated-local-key' }
										}
									}
								}
							: { plugin: ['private-plugin-package'] };
				const original = JSON.stringify({
					model: 'personal/model',
					provider: { personal: { options: { apiKey: '{env:PERSONAL_API_KEY}' } } },
					...setting
				});
				writeFileSync(join(source, 'config', 'assistant', 'opencode.json'), original);
				const plan = applyImport({
					sourceHome: source,
					destinationHome: destination,
					includeProviderAuth
				});
				expect(plan.entries).toHaveLength(0);
				expect(plan.warnings.join('\n')).toContain('non-portable native OpenCode configuration');
				expect(JSON.stringify(plan)).not.toContain('unrelated-mcp-key');
				expect(JSON.stringify(plan)).not.toContain('unrelated-local-key');
				expect(JSON.stringify(plan)).not.toContain('private-plugin-package');
				expect(existsSync(join(destination, 'config', 'assistant', 'opencode.json'))).toBe(false);
				expect(readFileSync(join(source, 'config', 'assistant', 'opencode.json'), 'utf8')).toBe(
					original
				);
			}
		}
	);

	it('copies only explicitly portable native model/provider intent without rewriting bytes', () => {
		const { source, destination } = fixture();
		mkdirSync(join(source, 'config', 'assistant'), { recursive: true });
		const original =
			'{"$schema":"https://opencode.ai/config.json","model":"personal/model","small_model":"personal/small","provider":{"personal":{"options":{"apiKey":"{env:PERSONAL_API_KEY}"}}}}\n';
		writeFileSync(join(source, 'config', 'assistant', 'opencode.json'), original);
		const plan = applyImport({ sourceHome: source, destinationHome: destination });
		expect(plan.entries.map((entry) => entry.relativeDestination)).toEqual([
			'config/assistant/opencode.json'
		]);
		expect(readFileSync(join(destination, 'config', 'assistant', 'opencode.json'), 'utf8')).toBe(
			original
		);
	});

	it('does not transfer unused referenced secrets or require missing files from skipped native config', () => {
		const { source, destination } = fixture();
		mkdirSync(join(source, 'config', 'assistant'), { recursive: true });
		mkdirSync(join(source, 'knowledge', 'secrets'), { recursive: true });
		writeFileSync(
			join(source, 'config', 'assistant', 'opencode.json'),
			JSON.stringify({
				plugin: ['unsupported-private-plugin'],
				provider: {
					personal: {
						options: {
							apiKey: '{file:/stash/secrets/missing.key}',
							headers: { Authorization: '{file:/stash/secrets/unused.key}' }
						}
					}
				}
			})
		);
		writeFileSync(join(source, 'knowledge', 'secrets', 'unused.key'), 'unused-provider-secret');
		writeFileSync(join(source, 'knowledge', 'secrets', 'auth.json'), '{}');
		const plan = applyImport({
			sourceHome: source,
			destinationHome: destination,
			includeProviderAuth: true
		});
		expect(plan.entries.map((entry) => entry.relativeDestination)).toEqual([
			'knowledge/secrets/auth.json'
		]);
		expect(JSON.stringify(plan)).not.toContain('unused-provider-secret');
		expect(existsSync(join(destination, 'knowledge', 'secrets', 'unused.key'))).toBe(false);
		expect(existsSync(join(destination, 'config', 'assistant', 'opencode.json'))).toBe(false);
	});

	it('skips native config with inline credentials without opt-in, preserving declarations', () => {
		const { source, destination } = fixture();
		providerConfiguration(source, 'literal-private-key');
		const excluded = planImport({ sourceHome: source, destinationHome: destination });
		expect(excluded.entries).toHaveLength(0);
		expect(excluded.warnings.join('\n')).toContain('inline provider credentials');
		expect(JSON.stringify(excluded)).not.toContain('literal-private-key');
		const included = planImport({
			sourceHome: source,
			destinationHome: destination,
			includeProviderAuth: true
		});
		expect(included.entries.map((entry) => entry.relativeDestination)).toEqual([
			'config/assistant/opencode.json'
		]);
		providerConfiguration(source, '{env:PERSONAL_API_KEY}');
		expect(planImport({ sourceHome: source, destinationHome: destination }).entries).toHaveLength(
			1
		);
	});

	it.each([
		'/etc/private.key',
		'/stash/secrets/../../outside',
		'/stash/secrets/nested/../key',
		'/stash/secrets/key\\escape'
	])('rejects unsafe provider reference %s without writing', (reference) => {
		const { source, destination } = fixture();
		providerConfiguration(source, `{file:${reference}}`);
		expect(() =>
			applyImport({ sourceHome: source, destinationHome: destination, includeProviderAuth: true })
		).toThrow('Provider file reference');
		expect(existsSync(join(destination, 'config', 'assistant', 'opencode.json'))).toBe(false);
	});

	it('rejects missing provider files before any writes', () => {
		const { source, destination } = fixture();
		providerConfiguration(source, '{file:/stash/secrets/missing.key}');
		expect(() =>
			applyImport({ sourceHome: source, destinationHome: destination, includeProviderAuth: true })
		).toThrow('missing or unreadable');
		expect(existsSync(join(destination, 'config', 'assistant', 'opencode.json'))).toBe(false);
	});

	it.each(['leaf', 'parent', 'config-parent', 'destination-parent', 'dangling-leaf'])(
		'rejects provider %s symlinks before any writes',
		(kind) => {
			if (process.platform === 'win32') return;
			const { root, source, destination } = fixture();
			providerConfiguration(source, '{file:/stash/secrets/private.key}');
			mkdirSync(join(source, 'knowledge', 'secrets'), { recursive: true });
			mkdirSync(join(root, 'outside'), { recursive: true });
			writeFileSync(join(root, 'outside', 'private.key'), 'outside-private-key');
			if (kind === 'leaf' || kind === 'dangling-leaf')
				symlinkSync(
					join(root, 'outside', kind === 'leaf' ? 'private.key' : 'missing.key'),
					join(source, 'knowledge', 'secrets', 'private.key')
				);
			else if (kind === 'parent') {
				rmSync(join(source, 'knowledge', 'secrets'), { recursive: true });
				symlinkSync(join(root, 'outside'), join(source, 'knowledge', 'secrets'));
			} else if (kind === 'config-parent') {
				rmSync(join(source, 'config', 'assistant'), { recursive: true });
				symlinkSync(join(root, 'outside'), join(source, 'config', 'assistant'));
			} else {
				writeFileSync(join(source, 'knowledge', 'secrets', 'private.key'), 'inside-key');
				mkdirSync(join(destination, 'knowledge'), { recursive: true });
				symlinkSync(join(root, 'outside'), join(destination, 'knowledge', 'secrets'));
			}
			expect(() =>
				applyImport({ sourceHome: source, destinationHome: destination, includeProviderAuth: true })
			).toThrow('unsafe component');
			expect(existsSync(join(destination, 'config', 'assistant', 'opencode.json'))).toBe(false);
			expect(readFileSync(join(root, 'outside', 'private.key'), 'utf8')).toBe(
				'outside-private-key'
			);
		}
	);

	it('rejects oversized provider files and redacts malformed native config diagnostics', () => {
		const { source, destination } = fixture();
		providerConfiguration(source, '{file:/stash/secrets/huge.key}');
		mkdirSync(join(source, 'knowledge', 'secrets'), { recursive: true });
		writeFileSync(join(source, 'knowledge', 'secrets', 'huge.key'), Buffer.alloc(1024 * 1024 + 1));
		expect(() =>
			applyImport({ sourceHome: source, destinationHome: destination, includeProviderAuth: true })
		).toThrow('1 MiB');
		writeFileSync(
			join(source, 'config', 'assistant', 'opencode.json'),
			'{"key":literal-private-key}'
		);
		try {
			planImport({ sourceHome: source, destinationHome: destination });
			throw new Error('expected invalid config to fail');
		} catch (error) {
			expect(String(error)).toContain('valid JSON');
			expect(String(error)).not.toContain('literal-private-key');
		}
	});

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

	it('keeps malformed mapped configuration values out of error messages', () => {
		const { source, destination } = fixture();
		mkdirSync(join(source, 'config', 'portal', 'discord'), { recursive: true });
		writeFileSync(
			join(source, 'config', 'portal', 'discord', 'credentials.json'),
			'{"token":literal-private-key}'
		);
		try {
			planImport({ sourceHome: source, destinationHome: destination, includePortalMaps: true });
			throw new Error('expected invalid map to fail');
		} catch (error) {
			expect(String(error)).toContain('valid JSON');
			expect(String(error)).not.toContain('literal-private-key');
		}
	});

	it('rejects backup manifest parent symlinks before reading outside its source', () => {
		if (process.platform === 'win32') return;
		const { root, source, destination } = fixture();
		mkdirSync(join(root, 'outside'), { recursive: true });
		writeFileSync(join(root, 'outside', 'memory.md'), 'outside');
		symlinkSync(join(root, 'outside'), join(source, 'knowledge'));
		writeFileSync(
			join(source, 'openpalm-backup.json'),
			JSON.stringify({
				version: 1,
				totalBytes: 7,
				files: [{ path: 'knowledge/memory.md', bytes: 7, sha256: 'a'.repeat(64) }]
			})
		);
		expect(() => planImport({ sourceHome: source, destinationHome: destination })).toThrow(
			'unsafe component'
		);
		expect(existsSync(join(destination, 'knowledge'))).toBe(false);
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
