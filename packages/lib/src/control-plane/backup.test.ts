import { afterEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	statSync,
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

	it('omits old AKM runtime configuration and already-staged config from portable knowledge', async () => {
		const source = join(root(), 'home');
		const destination = join(root(), 'backup');
		writeStackConfig(source, defaultStackConfig());
		for (const relativePath of [
			'config/akm/config.json',
			'config/akm/config.json.bak',
			'knowledge/imported-config/akm/config.json'
		]) {
			mkdirSync(join(source, relativePath, '..'), { recursive: true });
			writeFileSync(join(source, relativePath), '{"apiKey":"do-not-export"}');
		}
		mkdirSync(join(source, 'knowledge'), { recursive: true });
		writeFileSync(join(source, 'knowledge', 'memory.md'), 'portable');
		const manifest = await createBackup({ sourceHome: source, destination });
		expect(manifest.files.map((entry) => entry.path)).toEqual(['knowledge/memory.md']);
		expect(manifest.warnings).toContain(
			'Skipped historical knowledge/imported-config/akm; keep it in a private full-home backup, not searchable knowledge.'
		);
		expect(JSON.stringify(manifest)).not.toContain('do-not-export');
		expect(existsSync(join(source, 'config/akm/config.json.bak'))).toBe(true);
	});

	it('prunes dependency trees before reading their files and keeps authored project files', async () => {
		const source = join(root(), 'home');
		const destination = join(root(), 'backup');
		writeStackConfig(source, defaultStackConfig());
		for (const directory of [
			'workspace/project/node_modules',
			'knowledge/skills/demo/node_modules'
		]) {
			mkdirSync(join(source, directory), { recursive: true });
			writeFileSync(join(source, directory, 'dependency.js'), 'generated');
			writeFileSync(join(source, directory, '../package.json'), '{"name":"authored"}');
		}
		const manifest = await createBackup({ sourceHome: source, destination });
		expect(manifest.files.map((entry) => entry.path)).toEqual([
			'knowledge/skills/demo/package.json',
			'workspace/project/package.json'
		]);
		expect(manifest.warnings.filter((warning) => warning.includes('dependency tree'))).toHaveLength(
			2
		);
		expect(existsSync(join(source, 'workspace/project/node_modules/dependency.js'))).toBe(true);
	});

	it('backs up provider file references only with explicit opt-in and private permissions', async () => {
		const source = join(root(), 'home');
		const privateBackup = join(root(), 'private');
		const noSecrets = join(root(), 'public');
		writeStackConfig(source, defaultStackConfig());
		mkdirSync(join(source, 'config/assistant'), { recursive: true });
		mkdirSync(join(source, 'knowledge/secrets/providers'), { recursive: true });
		writeFileSync(
			join(source, 'config/assistant/opencode.json'),
			JSON.stringify({
				provider: { custom: { options: { apiKey: '{file:/stash/secrets/providers/key}' } } }
			})
		);
		writeFileSync(join(source, 'knowledge/secrets/providers/key'), 'private-provider-key');
		writeFileSync(join(source, 'knowledge/secrets/unrelated'), 'do-not-export');
		const omitted = await createBackup({ sourceHome: source, destination: noSecrets });
		expect(omitted.files.map((file) => file.path)).toEqual(['config/assistant/opencode.json']);
		expect(omitted.warnings.some((warning) => warning.includes('--include-provider-auth'))).toBe(
			true
		);
		const included = await createBackup({
			sourceHome: source,
			destination: privateBackup,
			includeProviderAuth: true
		});
		expect(included.files.map((file) => file.path)).toEqual([
			'config/assistant/opencode.json',
			'knowledge/secrets/providers/key'
		]);
		expect(JSON.stringify(included)).not.toContain('private-provider-key');
		expect(existsSync(join(privateBackup, 'knowledge/secrets/unrelated'))).toBe(false);
		if (process.platform !== 'win32') {
			expect(statSync(join(privateBackup, 'knowledge/secrets/providers/key')).mode & 0o777).toBe(
				0o600
			);
			expect(statSync(privateBackup).mode & 0o777).toBe(0o700);
		}
	});

	it('rejects an opted-in missing provider file before creating a destination', async () => {
		const source = join(root(), 'home');
		const destination = join(root(), 'backup');
		writeStackConfig(source, defaultStackConfig());
		mkdirSync(join(source, 'config/assistant'), { recursive: true });
		writeFileSync(
			join(source, 'config/assistant/opencode.json'),
			JSON.stringify({
				provider: { custom: { options: { apiKey: '{file:/stash/secrets/missing}' } } }
			})
		);
		await expect(
			createBackup({ sourceHome: source, destination, includeProviderAuth: true })
		).rejects.toThrow();
		expect(existsSync(destination)).toBe(false);
	});

	it('rejects provider parent symlinks rather than exporting unrelated host secrets', async () => {
		if (process.platform === 'win32') return;
		const source = join(root(), 'home');
		const destination = join(root(), 'backup');
		const outside = join(root(), 'outside');
		writeStackConfig(source, defaultStackConfig());
		mkdirSync(join(source, 'config/assistant'), { recursive: true });
		mkdirSync(join(source, 'knowledge/secrets'), { recursive: true });
		mkdirSync(outside);
		writeFileSync(join(outside, 'key'), 'not-authorized');
		symlinkSync(outside, join(source, 'knowledge/secrets/providers'), 'dir');
		writeFileSync(
			join(source, 'config/assistant/opencode.json'),
			JSON.stringify({
				provider: { custom: { options: { apiKey: '{file:/stash/secrets/providers/key}' } } }
			})
		);
		await expect(
			createBackup({ sourceHome: source, destination, includeProviderAuth: true })
		).rejects.toThrow();
		expect(existsSync(destination)).toBe(false);
	});

	it('rejects symlinked workspace roots without traversing external files', async () => {
		if (process.platform === 'win32') return;
		const source = join(root(), 'home');
		const destination = join(root(), 'backup');
		const outside = join(root(), 'outside');
		writeStackConfig(source, defaultStackConfig());
		mkdirSync(outside);
		writeFileSync(join(outside, 'private.txt'), 'not-authorized');
		symlinkSync(outside, join(source, 'workspace'), 'dir');
		await expect(createBackup({ sourceHome: source, destination })).rejects.toThrow();
		expect(existsSync(destination)).toBe(false);
	});

	it('does not silently back up inline provider credentials without the authentication opt-in', async () => {
		const source = join(root(), 'home');
		writeStackConfig(source, defaultStackConfig());
		mkdirSync(join(source, 'config/assistant'), { recursive: true });
		const config = { provider: { custom: { options: { apiKey: 'inline-private-key' } } } };
		writeFileSync(join(source, 'config/assistant/opencode.json'), JSON.stringify(config));
		const omitted = await createBackup({
			sourceHome: source,
			destination: join(root(), 'without-auth')
		});
		expect(omitted.files).toHaveLength(0);
		expect(
			omitted.warnings.some((warning) => warning.includes('inline provider credentials'))
		).toBe(true);
		expect(JSON.stringify(omitted)).not.toContain('inline-private-key');
		const destination = join(root(), 'with-auth');
		const included = await createBackup({
			sourceHome: source,
			destination,
			includeProviderAuth: true
		});
		expect(included.files.map((file) => file.path)).toEqual(['config/assistant/opencode.json']);
		expect(
			JSON.parse(readFileSync(join(destination, 'config/assistant/opencode.json'), 'utf8'))
		).toEqual(config);
		expect(JSON.stringify(included)).not.toContain('inline-private-key');
	});

	it('restores referenced provider files through a verified portable backup manifest', async () => {
		const source = join(root(), 'home');
		const destination = join(root(), 'backup');
		const restored = join(root(), 'restored');
		writeStackConfig(source, defaultStackConfig());
		mkdirSync(join(source, 'config/assistant'), { recursive: true });
		mkdirSync(join(source, 'knowledge/secrets'), { recursive: true });
		writeFileSync(
			join(source, 'config/assistant/opencode.json'),
			JSON.stringify({
				provider: { custom: { options: { apiKey: '{file:/stash/secrets/custom-key}' } } }
			})
		);
		writeFileSync(join(source, 'knowledge/secrets/custom-key'), 'private-provider-key');
		await createBackup({ sourceHome: source, destination, includeProviderAuth: true });
		writeStackConfig(restored, defaultStackConfig());
		mkdirSync(join(restored, 'system/stack'), { recursive: true });
		writeFileSync(join(restored, 'system/stack/stack.compose.yml'), 'services: {}');
		const { applyImport } = await import('./import.js');
		const plan = applyImport({
			sourceHome: destination,
			destinationHome: restored,
			includeProviderAuth: true
		});
		expect(plan.conflicts).toBe(0);
		expect(readFileSync(join(restored, 'knowledge/secrets/custom-key'), 'utf8')).toBe(
			'private-provider-key'
		);
		expect(JSON.stringify(plan)).not.toContain('private-provider-key');
		writeFileSync(
			join(destination, 'knowledge/secrets/custom-key'),
			'x'.repeat('private-provider-key'.length)
		);
		const { planImport } = await import('./import.js');
		expect(() =>
			planImport({ sourceHome: destination, destinationHome: restored, includeProviderAuth: true })
		).toThrow('Backup checksum mismatch');
	});

	for (const extraConfig of [
		{ mcp: { remote: { headers: { Authorization: 'Bearer unrelated-mcp-key' } } } },
		{ mcp: { local: { environment: { CUSTOM_TOKEN: 'unrelated-mcp-key' } } } },
		{ plugin: ['file:///private/custom-plugin.js'] }
	]) {
		it(`omits custom native runtime configuration even with provider opt-in (${Object.keys(extraConfig)[0]})`, async () => {
			const source = join(root(), 'home');
			writeStackConfig(source, defaultStackConfig());
			mkdirSync(join(source, 'config/assistant'), { recursive: true });
			mkdirSync(join(source, 'knowledge/secrets'), { recursive: true });
			const config = {
				provider: { custom: { options: { apiKey: '{file:/stash/secrets/missing-unused-key}' } } },
				...extraConfig
			};
			writeFileSync(join(source, 'config/assistant/opencode.json'), JSON.stringify(config));
			writeFileSync(join(source, 'knowledge/secrets/auth.json'), '{}');
			for (const includeProviderAuth of [false, true]) {
				const destination = join(root(), 'backup');
				const manifest = await createBackup({
					sourceHome: source,
					destination,
					includeProviderAuth
				});
				expect(manifest.files.map((file) => file.path)).toEqual(
					includeProviderAuth ? ['knowledge/secrets/auth.json'] : []
				);
				expect(existsSync(join(destination, 'config/assistant/opencode.json'))).toBe(false);
				expect(JSON.stringify(manifest)).not.toContain('unrelated-mcp-key');
				expect(
					manifest.warnings.some((warning) => warning.includes('custom configuration manually'))
				).toBe(true);
			}
			expect(
				JSON.parse(readFileSync(join(source, 'config/assistant/opencode.json'), 'utf8'))
			).toEqual(config);
		});
	}
});
