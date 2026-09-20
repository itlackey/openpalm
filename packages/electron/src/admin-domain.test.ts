import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultStackConfig } from '@openpalm/lib';

import {
	adminPortalMappings,
	backupFromAdmin,
	createAdminCredential,
	importFromAdmin,
	installFromAdmin,
	mapAdminPortalUser,
	removeAdminCredential,
	rotateAdminCredential,
	saveAdminConfig
} from './admin-domain.js';

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

async function install(
	config: unknown = defaultStackConfig()
): Promise<{ root: string; home: string }> {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-admin-domain-'));
	roots.push(root);
	const home = join(root, 'home');
	process.env.OP_HOME = home;
	process.env.OPENPALM_REPO_ROOT = join(import.meta.dir, '../../..');
	await installFromAdmin(config);
	return { root, home };
}

describe('Admin domain', () => {
	it('validates and preserves first-install port choices', async () => {
		const config = defaultStackConfig();
		config.assistant.port = 43_810;
		config.gateway.port = 43_830;
		const { home } = await install(config);
		const saved = JSON.parse(readFileSync(join(home, 'state', 'stack.json'), 'utf8'));
		expect(saved.assistant.port).toBe(43_810);
		expect(saved.gateway.port).toBe(43_830);

		await expect(install({ version: 1 })).rejects.toThrow('assistant');
	});

	it('installs the active skeleton and manages credentials and portal mappings', async () => {
		const { home } = await install();
		expect(JSON.parse(readFileSync(join(home, 'state', 'stack.json'), 'utf8')).version).toBe(1);
		const created = createAdminCredential(home, { username: 'family', policy: 'read' });
		const firstKey = readFileSync(created.keyFile, 'utf8');
		mapAdminPortalUser(home, {
			portal: 'discord',
			userId: '123456789012345678',
			username: 'family'
		});
		expect(adminPortalMappings(home).discord.users).toEqual({
			'123456789012345678': 'family'
		});
		rotateAdminCredential(home, 'family');
		expect(readFileSync(created.keyFile, 'utf8')).not.toBe(firstKey);
		expect(() => removeAdminCredential(home, 'family')).toThrow('assigned');
		mapAdminPortalUser(home, { portal: 'discord', userId: '123456789012345678' });
		removeAdminCredential(home, 'family');
	});

	it('creates a portable backup through the shared library', async () => {
		const { root, home } = await install();
		mkdirSync(join(home, 'knowledge', 'inbox'), { recursive: true });
		writeFileSync(join(home, 'knowledge', 'inbox', 'result.md'), 'durable result');
		const destination = join(root, 'backup');
		const manifest = await backupFromAdmin(home, { destination });
		expect(manifest.files.some((entry) => entry.path === 'knowledge/inbox/result.md')).toBe(true);
	});

	it('synchronizes portal bundles when Admin changes a default credential', async () => {
		const { home } = await install();
		createAdminCredential(home, { username: 'family', policy: 'read' });
		const config = JSON.parse(readFileSync(join(home, 'state', 'stack.json'), 'utf8'));
		config.portals.discord.credential = 'family';
		saveAdminConfig(home, config);
		const bundle = JSON.parse(
			readFileSync(join(home, 'state', 'portal-credentials', 'discord', 'credentials.json'), 'utf8')
		);
		expect(bundle.default).toBe('family');
		expect(bundle.credentials.family).toBeString();
	});

	it('reconciles delegated portal bundles after applying an Admin import', async () => {
		const { root, home } = await install();
		const source = join(root, 'old-home');
		mkdirSync(join(source, 'config', 'portal', 'discord'), { recursive: true });
		writeFileSync(
			join(source, 'config', 'portal', 'discord', 'credentials.json'),
			JSON.stringify({ version: 1, users: { '123456789012345678': 'owner' } })
		);
		importFromAdmin(home, { sourceHome: source, apply: true, includePortalMaps: true });
		const bundle = JSON.parse(
			readFileSync(join(home, 'state', 'portal-credentials', 'discord', 'credentials.json'), 'utf8')
		);
		expect(bundle.users).toEqual({ '123456789012345678': 'owner' });
	});
});
