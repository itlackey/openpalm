import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	credentialRegistryFile,
	defaultStackConfig,
	ensureStackConfig,
	parseStackConfig,
	readStackConfig,
	stackConfigFile,
	writeStackConfig
} from './stack-config.js';

const homes: string[] = [];

function home(): string {
	const path = mkdtempSync(join(tmpdir(), 'openpalm-stack-config-'));
	homes.push(path);
	return path;
}

afterEach(() => {
	for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('StackConfigV2', () => {
	it('defaults to one assistant, three reusable credentials, and no ingress intent', () => {
		expect(defaultStackConfig()).toEqual({
			version: 2,
			assistant: { bindAddress: '127.0.0.1', port: 3810 },
			gateway: { enabled: false, bindAddress: '127.0.0.1', port: 3830 },
			credentials: {
				owner: { id: 'owner', policy: 'full' },
				discord: { id: 'discord', policy: 'chat' },
				slack: { id: 'slack', policy: 'chat' }
			},
			portals: {
				discord: { enabled: false, credential: 'discord' },
				slack: { enabled: false, credential: 'slack' }
			}
		});
	});

	it('rejects invalid versions, binds, credentials, and portal references', () => {
		expect(parseStackConfig({ version: 3 })).toEqual({
			ok: false,
			error: 'stack config must use version 2'
		});
		const invalid = defaultStackConfig();
		invalid.gateway.bindAddress = 'public.example.com';
		invalid.gateway.port = 70_000;
		expect(parseStackConfig(invalid).ok).toBe(false);
		const invalidPolicy = defaultStackConfig();
		const owner = invalidPolicy.credentials.owner;
		if (!owner) throw new Error('default owner credential missing');
		owner.policy = 'unsafe' as never;
		expect(parseStackConfig(invalidPolicy).ok).toBe(false);
		const missing = defaultStackConfig();
		missing.portals.discord.credential = 'missing';
		expect(parseStackConfig(missing).ok).toBe(false);
		const duplicate = defaultStackConfig();
		const slack = duplicate.credentials.slack;
		if (!slack) throw new Error('default slack credential missing');
		slack.id = 'owner';
		expect(parseStackConfig(duplicate).ok).toBe(false);
		expect(parseStackConfig({ ...defaultStackConfig(), voice: { enabled: true } })).toEqual({
			ok: false,
			error: 'stack config contains unsupported settings'
		});
	});

	it('makes portal enablement imply the gateway', () => {
		const config = defaultStackConfig();
		config.portals.discord.enabled = true;
		const parsed = parseStackConfig(config);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.config.gateway.enabled).toBe(true);
	});

	it('migrates legacy environment intent and policies into named credentials', () => {
		const root = home();
		mkdirSync(join(root, 'state'), { recursive: true });
		writeFileSync(
			join(root, 'state', 'stack.env'),
			[
				'OP_ENABLED_ADDONS=api,discord,ollama,voice',
				'OP_ASSISTANT_BIND_ADDRESS=192.168.1.12',
				'OP_ASSISTANT_PORT=4910',
				'OP_GUARDIAN_BIND_ADDRESS=0.0.0.0',
				'GUARDIAN_OWNER_POLICY=read',
				'GUARDIAN_DISCORD_POLICY=full',
				''
			].join('\n')
		);
		const result = readStackConfig(root);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.source).toBe('legacy-env');
		expect(result.config.gateway.enabled).toBe(true);
		expect(result.config.portals.discord.enabled).toBe(true);
		expect(result.config.assistant).toEqual({ bindAddress: '192.168.1.12', port: 4910 });
		expect(result.config.credentials.owner?.policy).toBe('read');
		expect(result.config.credentials.discord?.policy).toBe('full');
	});

	it('upgrades both released and interim V1 shapes', () => {
		const root = home();
		mkdirSync(join(root, 'state'), { recursive: true });
		writeFileSync(
			stackConfigFile(root),
			JSON.stringify({
				version: 1,
				assistant: { bindAddress: '127.0.0.1', port: 3810 },
				gateway: { enabled: true, bindAddress: '127.0.0.1', port: 3830, policy: 'read' },
				portals: {
					discord: { enabled: false, policy: 'chat' },
					slack: { enabled: false, policy: 'full' }
				}
			})
		);
		const result = readStackConfig(root);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.source).toBe('v1');
		expect(result.config.credentials.owner?.policy).toBe('read');
		ensureStackConfig(root);
		expect(JSON.parse(readFileSync(stackConfigFile(root), 'utf8')).version).toBe(2);

		writeFileSync(
			stackConfigFile(root),
			JSON.stringify({
				version: 1,
				gateway: { enabled: true, bindAddress: '127.0.0.1', port: 3830 },
				portals: { discord: { enabled: false }, slack: { enabled: false } }
			})
		);
		expect(readStackConfig(root).ok).toBe(true);
	});

	it('atomically writes intent and derives runtime registry and portal selections', () => {
		const root = home();
		const config = defaultStackConfig();
		config.portals.slack.enabled = true;
		writeStackConfig(root, config);

		expect(JSON.parse(readFileSync(stackConfigFile(root), 'utf8')).version).toBe(2);
		const registry = JSON.parse(readFileSync(credentialRegistryFile(root), 'utf8')) as {
			credentials: Array<{ username: string; policy: string }>;
		};
		expect(registry.credentials).toContainEqual({ username: 'owner', id: 'owner', policy: 'full' });
		const env = readFileSync(join(root, 'state', 'stack.env'), 'utf8');
		expect(env).toContain('OP_ENABLED_ADDONS=gateway,slack');
		expect(env).not.toContain('OP_DISCORD_CREDENTIAL=');
		expect(env).not.toContain('OP_SLACK_CREDENTIAL=');
		expect(ensureStackConfig(root).portals.slack.enabled).toBe(true);
	});

	it('repairs derived runtime env from JSON source of truth', () => {
		const root = home();
		const config = defaultStackConfig();
		config.gateway.enabled = true;
		writeStackConfig(root, config);
		writeFileSync(
			join(root, 'state', 'stack.env'),
			'OP_ENABLED_ADDONS=voice\nGUARDIAN_OWNER_POLICY=full\n'
		);

		ensureStackConfig(root);

		const env = readFileSync(join(root, 'state', 'stack.env'), 'utf8');
		expect(env).toContain('OP_ENABLED_ADDONS=gateway');
		expect(env).not.toContain('voice');
		expect(env).not.toContain('GUARDIAN_OWNER_POLICY');
	});
});
