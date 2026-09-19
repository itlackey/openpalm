import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

async function setup(): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-lean-config-'));
	roots.push(root);
	process.env.OP_HOME = join(root, 'home');
	process.env.OPENPALM_REPO_ROOT = join(import.meta.dir, '../../../..');
	await bootstrapLeanInstall({ start: false });
	return process.env.OP_HOME;
}

describe('lean config commands', () => {
	it('persists direct Assistant exposure and portal credential selection without Docker', async () => {
		await setup();

		await main(['config', 'assistant', '--bind', '0.0.0.0', '--port', '4910', '--no-apply']);
		await main(['credential', 'add', 'support-bot', 'read']);
		await main(['config', 'portal', 'discord', '--credential', 'support-bot', '--no-apply']);

		const config = JSON.parse(
			readFileSync(join(process.env.OP_HOME, 'state', 'stack.json'), 'utf8')
		) as {
			assistant: { bindAddress: string; port: number };
			credentials: Record<string, { policy: string }>;
			portals: { discord: { credential: string } };
		};
		expect(config.assistant).toEqual({ bindAddress: '0.0.0.0', port: 4910 });
		expect(config.credentials['support-bot']?.policy).toBe('read');
		expect(config.portals.discord.credential).toBe('support-bot');
		const env = readFileSync(join(process.env.OP_HOME, 'state', 'stack.env'), 'utf8');
		expect(env).toContain('OP_ASSISTANT_BIND_ADDRESS=0.0.0.0');
		expect(env).not.toContain('OP_DISCORD_CREDENTIAL=');
		const bundle = JSON.parse(
			readFileSync(
				join(process.env.OP_HOME, 'state', 'portal-credentials', 'discord', 'credentials.json'),
				'utf8'
			)
		) as { default: string; credentials: Record<string, string> };
		expect(bundle.default).toBe('support-bot');
		expect(Object.keys(bundle.credentials)).toEqual(['support-bot']);
	});

	it('configures and disables the Guardian OAuth resource server without Docker', async () => {
		await setup();
		await main([
			'config',
			'oauth',
			'--resource',
			'https://agent.example/mcp',
			'--issuer',
			'https://identity.example/',
			'--jwks-url',
			'https://identity.example/jwks.json',
			'--scopes',
			'openpalm,profile',
			'--no-apply'
		]);
		const path = join(process.env.OP_HOME ?? '', 'config', 'guardian', 'oauth.json');
		expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
			version: 1,
			enabled: true,
			resource: 'https://agent.example/mcp',
			issuer: 'https://identity.example/',
			jwksUrl: 'https://identity.example/jwks.json',
			audience: 'https://agent.example/mcp',
			scopes: ['openpalm', 'profile'],
			algorithms: ['RS256']
		});
		await main(['config', 'oauth', '--disable', '--no-apply']);
		expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, enabled: false });
	});
});
