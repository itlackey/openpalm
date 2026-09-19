import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../main.js';
import { bootstrapInstall } from './install.js';

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

async function setup(): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-portal-command-'));
	roots.push(root);
	process.env.OP_HOME = join(root, 'home');
	process.env.OPENPALM_REPO_ROOT = join(import.meta.dir, '../../../..');
	await bootstrapInstall({ start: false });
	return root;
}

describe('portal commands', () => {
	it('stores validated allowlists in stack intent and derived env', async () => {
		await setup();
		await main([
			'portal',
			'access',
			'discord',
			'--guilds',
			'123456789012345678',
			'--users',
			'987654321098765432',
			'--blocked-users',
			'111111111111111111',
			'--no-apply'
		]);
		const config = JSON.parse(
			readFileSync(join(process.env.OP_HOME ?? '', 'state', 'stack.json'), 'utf8')
		) as { portals: { discord: { access: { guilds: string[]; blockedUsers: string[] } } } };
		expect(config.portals.discord.access.guilds).toEqual(['123456789012345678']);
		expect(config.portals.discord.access.blockedUsers).toEqual(['111111111111111111']);
		const env = readFileSync(join(process.env.OP_HOME ?? '', 'state', 'stack.env'), 'utf8');
		expect(env).toContain('DISCORD_ALLOWED_GUILDS=123456789012345678');
		expect(env).toContain('DISCORD_BLOCKED_USERS=111111111111111111');
	});

	it('writes portal tokens as private file secrets without putting them in stack env', async () => {
		const root = await setup();
		const bot = join(root, 'bot-token');
		const app = join(root, 'app-token');
		writeFileSync(bot, 'xoxb-openpalm-test-token');
		writeFileSync(app, 'xapp-openpalm-test-token');
		await main([
			'portal',
			'token',
			'slack',
			'--bot-token-file',
			bot,
			'--app-token-file',
			app,
			'--no-apply'
		]);
		const secretRoot = join(process.env.OP_HOME ?? '', 'state', 'secrets');
		expect(readFileSync(join(secretRoot, 'slack_bot_token'), 'utf8')).toBe(
			'xoxb-openpalm-test-token\n'
		);
		expect(readFileSync(join(secretRoot, 'slack_app_token'), 'utf8')).toBe(
			'xapp-openpalm-test-token\n'
		);
		const env = readFileSync(join(process.env.OP_HOME ?? '', 'state', 'stack.env'), 'utf8');
		expect(env).not.toContain('xoxb-openpalm-test-token');
	});
});
