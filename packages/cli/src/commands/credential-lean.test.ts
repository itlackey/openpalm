import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../main-lean.js';
import { bootstrapLeanInstall } from './install-lean.js';

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

async function setup(): Promise<{ root: string; home: string }> {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-lean-credential-'));
	roots.push(root);
	const home = join(root, 'home');
	process.env.OP_HOME = home;
	process.env.OPENPALM_REPO_ROOT = join(import.meta.dir, '../../../..');
	await bootstrapLeanInstall({ start: false });
	return { root, home };
}

describe('lean credential commands', () => {
	it('adds, changes, rotates, and revokes a named credential', async () => {
		const { root, home } = await setup();
		const firstKey = join(root, 'first.key');
		const secondKey = join(root, 'second.key');
		writeFileSync(firstKey, `${'a'.repeat(40)}\n`);
		writeFileSync(secondKey, `${'b'.repeat(40)}\n`);

		await main(['credential', 'add', 'automation', 'read', '--key-file', firstKey]);
		let config = JSON.parse(readFileSync(join(home, 'state', 'stack.json'), 'utf8')) as {
			credentials: Record<string, { id: string; policy: string }>;
		};
		const firstId = config.credentials.automation?.id;
		expect(firstId).toMatch(/^cred_[a-f0-9]{32}$/);
		expect(config.credentials.automation?.policy).toBe('read');
		expect(
			readFileSync(join(home, 'state', 'credentials', 'automation', 'key'), 'utf8').trim()
		).toBe('a'.repeat(40));

		await main(['credential', 'set-policy', 'automation', 'full']);
		await main(['credential', 'rotate', 'automation', '--key-file', secondKey]);
		config = JSON.parse(readFileSync(join(home, 'state', 'stack.json'), 'utf8')) as typeof config;
		expect(config.credentials.automation).toEqual({ id: firstId, policy: 'full' });
		expect(
			readFileSync(join(home, 'state', 'credentials', 'automation', 'key'), 'utf8').trim()
		).toBe('b'.repeat(40));

		await main(['credential', 'remove', 'automation']);
		expect(existsSync(join(home, 'state', 'credentials', 'automation'))).toBe(false);
	});

	it('prevents duplicate keys and removal while a portal uses the credential', async () => {
		const { root } = await setup();
		const key = join(root, 'shared.key');
		writeFileSync(key, `${'z'.repeat(40)}\n`);
		await main(['credential', 'add', 'support', 'chat', '--key-file', key]);
		await expect(
			main(['credential', 'add', 'duplicate', 'read', '--key-file', key])
		).rejects.toThrow('already assigned');
		await main(['config', 'portal', 'discord', '--credential', 'support', '--no-apply']);
		await expect(main(['credential', 'remove', 'support'])).rejects.toThrow('assigned to discord');
	});

	it('maps platform users to credentials, synchronizes rotation, and blocks mapped removal', async () => {
		const { root, home } = await setup();
		const firstKey = join(root, 'mapped-first.key');
		const secondKey = join(root, 'mapped-second.key');
		writeFileSync(firstKey, `${'m'.repeat(40)}\n`);
		writeFileSync(secondKey, `${'n'.repeat(40)}\n`);
		await main(['credential', 'add', 'mapped-user', 'read', '--key-file', firstKey]);
		await main(['credential', 'map', 'discord', '1234567890', 'mapped-user']);
		await main(['credential', 'map', 'slack', 'U123ABC', 'mapped-user']);

		const discordBundle = () =>
			JSON.parse(
				readFileSync(
					join(home, 'state', 'portal-credentials', 'discord', 'credentials.json'),
					'utf8'
				)
			) as {
				users: Record<string, string>;
				credentials: Record<string, string>;
			};
		expect(discordBundle().users['1234567890']).toBe('mapped-user');
		expect(discordBundle().credentials['mapped-user']).toBe('m'.repeat(40));
		await expect(main(['credential', 'remove', 'mapped-user'])).rejects.toThrow(
			'discord user 1234567890'
		);

		await main(['credential', 'rotate', 'mapped-user', '--key-file', secondKey]);
		expect(discordBundle().credentials['mapped-user']).toBe('n'.repeat(40));
		await main(['credential', 'unmap', 'discord', '1234567890']);
		await main(['credential', 'unmap', 'slack', 'U123ABC']);
		await main(['credential', 'remove', 'mapped-user']);
	});

	it('maps OAuth subjects to the same credential registry and policy', async () => {
		const { root, home } = await setup();
		const key = join(root, 'oauth.key');
		writeFileSync(key, `${'q'.repeat(40)}\n`);
		await main(['credential', 'add', 'oauth-user', 'full', '--key-file', key]);
		await main([
			'credential',
			'map',
			'oauth',
			'https://identity.example/',
			'user-42',
			'oauth-user'
		]);
		const mapping = JSON.parse(
			readFileSync(join(home, 'config', 'guardian', 'oauth-identities.json'), 'utf8')
		) as { identities: Array<{ issuer: string; subject: string; username: string }> };
		expect(mapping.identities).toEqual([
			{
				issuer: 'https://identity.example/',
				subject: 'user-42',
				username: 'oauth-user'
			}
		]);
		await expect(main(['credential', 'remove', 'oauth-user'])).rejects.toThrow(
			'oauth https://identity.example/ subject user-42'
		);
		await main([
			'credential',
			'unmap',
			'oauth',
			'https://identity.example/',
			'user-42'
		]);
		await main(['credential', 'remove', 'oauth-user']);
	});
});
