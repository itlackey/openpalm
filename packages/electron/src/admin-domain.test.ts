import { afterEach, describe, expect, it } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultStackConfig, MANAGED_FILES, SEEDED_FILES } from '@openpalm/lib';
import { retainAdminE2eHome } from '../scripts/admin-e2e-retention.mjs';

import {
	adminPortalMappings,
	adminPortalTokens,
	backupFromAdmin,
	createAdminCredential,
	externalAdminUrl,
	importFromAdmin,
	installFromAdmin,
	isAdminPageUrl,
	mapAdminPortalUser,
	removeAdminCredential,
	rotateAdminCredential,
	saveAdminConfig
} from './admin-domain.js';

const roots: string[] = [];
const originalHome = process.env.OP_HOME;
const originalRepo = process.env.OPENPALM_REPO_ROOT;
const originalSkeleton = process.env.OPENPALM_SKELETON_DIR;
const originalProject = process.env.OP_PROJECT_NAME;

afterEach(() => {
	if (originalHome === undefined) delete process.env.OP_HOME;
	else process.env.OP_HOME = originalHome;
	if (originalRepo === undefined) delete process.env.OPENPALM_REPO_ROOT;
	else process.env.OPENPALM_REPO_ROOT = originalRepo;
	if (originalSkeleton === undefined) delete process.env.OPENPALM_SKELETON_DIR;
	else process.env.OPENPALM_SKELETON_DIR = originalSkeleton;
	if (originalProject === undefined) delete process.env.OP_PROJECT_NAME;
	else process.env.OP_PROJECT_NAME = originalProject;
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
	it('installs explicitly selected homes with distinct stable Compose projects without changing OP_HOME', async () => {
		const { root, home } = await install();
		const other = join(root, 'other-home');
		const third = join(root, 'third-home');
		delete process.env.OP_PROJECT_NAME;
		await installFromAdmin(defaultStackConfig(), other);
		await installFromAdmin(defaultStackConfig(), third);
		expect(process.env.OP_HOME).toBe(home);
		const first = readFileSync(join(other, 'state', 'stack.env'), 'utf8');
		const second = readFileSync(join(third, 'state', 'stack.env'), 'utf8');
		expect(first.match(/OP_PROJECT_NAME=(.*)/)?.[1]).toMatch(/^openpalm-[a-f0-9]{12}$/);
		expect(first.match(/OP_PROJECT_NAME=(.*)/)?.[1]).not.toBe(
			second.match(/OP_PROJECT_NAME=(.*)/)?.[1]
		);
		process.env.OP_PROJECT_NAME = 'launch-default-project';
		const fourth = join(root, 'fourth-home');
		await installFromAdmin(defaultStackConfig(), fourth);
		expect(readFileSync(join(fourth, 'state', 'stack.env'), 'utf8')).not.toContain(
			'launch-default-project'
		);
	});
	it('authenticates the exact local Admin page with platform-aware file paths', () => {
		const windows = 'file:///C:/Users/Runner/OpenPalm%20Admin/resources/app.asar/admin/index.html';
		expect(
			isAdminPageUrl(
				'file:///c:/Users/Runner/OpenPalm%20Admin/resources/app.asar/admin/index.html',
				windows,
				true
			)
		).toBe(true);
		expect(
			isAdminPageUrl(
				'file:///C:/users/runner/OpenPalm%20Admin/resources/app.asar/admin/index.html',
				windows,
				true
			)
		).toBe(true);
		const posix = 'file:///opt/OpenPalm%20Admin/admin/index.html';
		expect(isAdminPageUrl('file:///opt/OpenPalm%20Admin/admin/index.html', posix, false)).toBe(
			true
		);
		for (const value of [
			undefined,
			'invalid',
			'https://example.com/index.html',
			'file:///opt/openpalm%20admin/admin/index.html',
			'file:///opt/OpenPalm%20Admin/admin/evil.html',
			'file:///opt/OpenPalm%20Admin/admin/index.html?query=1',
			'file:///opt/OpenPalm%20Admin/admin/index.html#frame',
			'file://remote/opt/OpenPalm%20Admin/admin/index.html',
			'file:///opt/OpenPalm%20Admin/admin%2Findex.html'
		]) {
			expect(isAdminPageUrl(value, posix, false)).toBe(false);
		}
		for (const value of [
			'file:///d:/Users/Runner/OpenPalm%20Admin/resources/app.asar/admin/index.html',
			'file:///c:/Users/Runner/OpenPalm%20Admin/resources/app.asar/admin/other.html',
			'file://remote/share/index.html'
		]) {
			expect(isAdminPageUrl(value, windows, true)).toBe(false);
		}
	});

	it('packages exactly the shared managed and seeded Skeleton allowlists', () => {
		const builder = Bun.YAML.parse(
			readFileSync(join(import.meta.dir, '..', 'electron-builder.yml'), 'utf8')
		) as { extraResources: Array<{ to: string; filter: string[] }> };
		const resource = builder.extraResources.find((entry) => entry.to === 'skeleton');
		if (!resource) throw new Error('Missing packaged Skeleton resources.');
		expect([...resource.filter].sort()).toEqual([...MANAGED_FILES, ...SEEDED_FILES].sort());
	});

	it('materializes a complete fresh home using only packaged Skeleton resources', async () => {
		const builder = Bun.YAML.parse(
			readFileSync(join(import.meta.dir, '..', 'electron-builder.yml'), 'utf8')
		) as { extraResources: Array<{ to: string; filter: string[] }> };
		const resource = builder.extraResources.find((entry) => entry.to === 'skeleton');
		if (!resource) throw new Error('Missing packaged Skeleton resources.');
		const filter = resource.filter;
		const root = mkdtempSync(join(tmpdir(), 'openpalm-admin-packaged-seed-'));
		roots.push(root);
		const packagedSkeleton = join(root, 'resources', 'skeleton');
		const source = join(import.meta.dir, '..', '..', 'skeleton');
		for (const path of filter) {
			const destination = join(packagedSkeleton, path);
			mkdirSync(dirname(destination), { recursive: true });
			copyFileSync(join(source, path), destination);
		}
		process.env.OPENPALM_SKELETON_DIR = packagedSkeleton;
		const { home } = await install();
		for (const path of [...MANAGED_FILES, ...SEEDED_FILES]) {
			expect(readFileSync(join(home, path))).toEqual(readFileSync(join(source, path)));
		}
	});

	it('retains explicit and provider-backed E2E homes without requiring KEEP flags', () => {
		for (const name of [
			'OPENPALM_ADMIN_E2E_HOME',
			'OPENPALM_ADMIN_E2E_PROVIDER',
			'OPENPALM_ADMIN_E2E_PROVIDER_KEY',
			'OPENPALM_ADMIN_E2E_PROVIDER_KEY_FILE'
		]) {
			expect(
				retainAdminE2eHome({ [name]: 'supplied-test-value', OPENPALM_ADMIN_E2E_KEEP_HOME: 'false' })
			).toBe(true);
		}
		expect(retainAdminE2eHome({ OPENPALM_ADMIN_E2E_KEEP_HOME: 'true' })).toBe(true);
		expect(retainAdminE2eHome({ OPENPALM_ADMIN_E2E_KEEP_RUNNING: 'true' })).toBe(true);
		expect(retainAdminE2eHome({})).toBe(false);
	});

	it('retains unexpectedly populated or malformed E2E provider auth', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-admin-retention-'));
		roots.push(root);
		mkdirSync(join(root, 'knowledge', 'secrets'), { recursive: true });
		const auth = join(root, 'knowledge', 'secrets', 'auth.json');
		writeFileSync(auth, '{}');
		expect(retainAdminE2eHome({}, root)).toBe(false);
		writeFileSync(auth, JSON.stringify({ test: { type: 'api', key: 'synthetic-test-key' } }));
		expect(retainAdminE2eHome({}, root)).toBe(true);
		writeFileSync(auth, '{malformed');
		expect(retainAdminE2eHome({}, root)).toBe(true);
		expect(readFileSync(auth, 'utf8')).toBe('{malformed');
	});

	it('opens ordinary HTTP and HTTPS links without embedded credentials', () => {
		for (const address of [
			'http://127.0.0.1:3810',
			'http://192.168.0.201:3810',
			'http://[::1]:3810',
			'http://example.com',
			'https://example.com/sign-in?state=abc'
		]) {
			expect(externalAdminUrl(address)).toBe(new URL(address).href);
		}
		for (const value of [
			null,
			42,
			'file:///tmp/private',
			'javascript:alert(1)',
			'https://user:password@example.com',
			`https://example.com/${'a'.repeat(4096)}`
		]) {
			expect(() => externalAdminUrl(value)).toThrow();
		}
	});

	it('requires portal-specific initial tokens and keeps blank Slack values unchanged', () => {
		expect(() => adminPortalTokens({ portal: 'discord' }, {})).toThrow('Discord bot token');
		expect(() => adminPortalTokens({ portal: 'slack', botToken: 'bot' }, {})).toThrow('Both Slack');
		expect(adminPortalTokens({ portal: 'slack', botToken: 'bot', appToken: 'app' }, {})).toEqual({
			portal: 'slack',
			botToken: 'bot',
			appToken: 'app'
		});
		const configured = { slack_bot_token: true, slack_app_token: true };
		expect(
			adminPortalTokens({ portal: 'slack', botToken: '', appToken: 'new-app' }, configured)
		).toEqual({ portal: 'slack', appToken: 'new-app' });
		expect(() =>
			adminPortalTokens({ portal: 'slack', botToken: '', appToken: '' }, configured)
		).toThrow('at least one');
		expect(() =>
			adminPortalTokens({ portal: 'slack', botToken: 123, appToken: 'app' }, configured)
		).toThrow('Invalid portal token');
		expect(() => adminPortalTokens([], {})).toThrow();
	});

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
		process.env.OP_HOME = join(root, 'unrelated-default');
		const source = join(root, 'old-home');
		mkdirSync(join(source, 'config', 'portal', 'discord'), { recursive: true });
		writeFileSync(
			join(source, 'config', 'portal', 'discord', 'credentials.json'),
			JSON.stringify({ version: 1, users: { '123456789012345678': 'owner' } })
		);
		const preview = importFromAdmin(home, { sourceHome: source, includePortalMaps: true });
		importFromAdmin(home, {
			sourceHome: source,
			apply: true,
			previewDigest: preview.digest,
			includePortalMaps: true
		});
		const bundle = JSON.parse(
			readFileSync(join(home, 'state', 'portal-credentials', 'discord', 'credentials.json'), 'utf8')
		);
		expect(bundle.users).toEqual({ '123456789012345678': 'owner' });
	});
});
