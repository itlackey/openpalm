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

describe('lean config commands', () => {
	it('persists direct Assistant exposure and portal credential selection without Docker', async () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-lean-config-'));
		roots.push(root);
		process.env.OP_HOME = join(root, 'home');
		process.env.OPENPALM_REPO_ROOT = join(import.meta.dir, '../../../..');
		await bootstrapLeanInstall({ start: false });

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
		expect(env).toContain('OP_DISCORD_CREDENTIAL=support-bot');
	});
});
