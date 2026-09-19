import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrapLeanInstall } from './install-lean.js';
import { connectionDetails } from './connect-lean.js';

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
	const root = mkdtempSync(join(tmpdir(), 'openpalm-connect-command-'));
	roots.push(root);
	process.env.OP_HOME = join(root, 'home');
	process.env.OPENPALM_REPO_ROOT = join(import.meta.dir, '../../../..');
	await bootstrapLeanInstall({ start: false });
	return process.env.OP_HOME;
}

describe('lean connection guidance', () => {
	it('describes trusted native OpenCode access without exposing its password', async () => {
		const home = await setup();
		const details = connectionDetails(home, 'opencode');
		expect(details.url).toBe('http://127.0.0.1:3810');
		expect(details.username).toBe('opencode');
		expect(details.passwordFile).toEndWith('/state/secrets/op_opencode_password');
		expect(details).not.toHaveProperty('password');
	});

	it('describes MCP and Claude configuration without revealing keys by default', async () => {
		const home = await setup();
		const mcp = connectionDetails(home, 'mcp', { credential: 'owner' });
		expect(mcp.url).toBe('http://127.0.0.1:3830/mcp');
		expect(mcp.credentialKey).toBeUndefined();
		const revealed = connectionDetails(home, 'claude', {
			credential: 'owner',
			showKey: true
		});
		expect(revealed.credentialKey?.length).toBeGreaterThanOrEqual(32);
		expect(revealed.extension).toContain('openpalm-claude-desktop-0.14.0.mcpb');
	});
});
