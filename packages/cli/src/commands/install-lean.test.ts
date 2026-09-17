import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCredentialId, defaultStackConfig } from '@openpalm/lib/lean';

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

describe('lean install', () => {
	it('materializes one-stack intent without launching a browser or Docker', async () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-lean-install-'));
		roots.push(root);
		process.env.OP_HOME = join(root, 'home');
		process.env.OPENPALM_REPO_ROOT = join(import.meta.dir, '../../../..');

		await bootstrapLeanInstall({ start: false });

		const config = JSON.parse(
			readFileSync(join(process.env.OP_HOME, 'state', 'stack.json'), 'utf8')
		) as {
			version: number;
			assistant: { bindAddress: string; port: number };
			gateway: { enabled: boolean };
			credentials: Record<string, { policy: string }>;
		};
		expect(config).toMatchObject({
			version: 2,
			assistant: { bindAddress: '127.0.0.1', port: 3810 },
			gateway: { enabled: false },
			credentials: { owner: { policy: 'full' } }
		});
		expect(
			readFileSync(join(process.env.OP_HOME, 'system', 'stack', 'stack.compose.yml'), 'utf8')
		).toContain('assistant:');
		expect(readFileSync(join(process.env.OP_HOME, 'state', 'stack.env'), 'utf8')).toContain(
			'OP_ENABLED_ADDONS='
		);
		expect(
			readFileSync(join(process.env.OP_HOME, 'state', 'credentials', 'owner', 'key'), 'utf8').trim()
		).toHaveLength(43);
	});

	it('reconciles named keys and portal bundles to supplied install intent', async () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-lean-install-config-'));
		roots.push(root);
		process.env.OP_HOME = join(root, 'home');
		process.env.OPENPALM_REPO_ROOT = join(import.meta.dir, '../../../..');
		const config = defaultStackConfig();
		config.credentials.automation = { id: createCredentialId(), policy: 'read' };
		config.portals.discord.credential = 'automation';
		const configFile = join(root, 'stack.json');
		writeFileSync(configFile, JSON.stringify(config));

		await bootstrapLeanInstall({ start: false, configFile });

		expect(existsSync(join(process.env.OP_HOME, 'state', 'credentials', 'automation', 'key'))).toBe(
			true
		);
		const bundle = JSON.parse(
			readFileSync(
				join(process.env.OP_HOME, 'state', 'portal-credentials', 'discord', 'credentials.json'),
				'utf8'
			)
		) as { default: string; credentials: Record<string, string> };
		expect(bundle.default).toBe('automation');
		expect(Object.keys(bundle.credentials)).toEqual(['automation']);
	});
});
