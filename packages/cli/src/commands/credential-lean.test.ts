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
});
