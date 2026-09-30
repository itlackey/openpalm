import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	credentialRegistryFile,
	defaultStackConfig,
	ensureStackConfig,
	hostTimezone,
	stackConfigEnv,
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

describe('StackConfig', () => {
	it('defaults to one assistant, three reusable credentials, and no ingress intent', () => {
		expect(defaultStackConfig()).toEqual({
			version: 1,
			assistant: {
				bindAddress: '127.0.0.1',
				port: 3810,
				timezone: hostTimezone(),
				automaticMemory: true
			},
			gateway: { enabled: false, bindAddress: '127.0.0.1', port: 3830 },
			credentials: {
				owner: { id: 'owner', policy: 'full' },
				discord: { id: 'discord', policy: 'chat' },
				slack: { id: 'slack', policy: 'chat' }
			},
			portals: {
				discord: {
					enabled: false,
					credential: 'discord',
					access: { guilds: [], roles: [], users: [], blockedUsers: [] }
				},
				slack: {
					enabled: false,
					credential: 'slack',
					access: { channels: [], users: [], blockedUsers: [] }
				}
			}
		});
	});

	it('validates timezone and memory preferences and derives nonsecret runtime values', () => {
		const config = defaultStackConfig();
		config.assistant.timezone = 'America/Chicago';
		config.assistant.automaticMemory = false;
		expect(parseStackConfig(config).ok).toBe(true);
		expect(stackConfigEnv(config)).toMatchObject({
			OP_TIMEZONE: 'America/Chicago',
			OP_AUTOMATIC_MEMORY: '0'
		});
		expect(
			parseStackConfig({ ...config, assistant: { ...config.assistant, timezone: 'No/Such_Zone' } })
				.ok
		).toBe(false);
		expect(
			parseStackConfig({ ...config, assistant: { ...config.assistant, timezone: 'UTC\nBAD=1' } }).ok
		).toBe(false);
		expect(
			parseStackConfig({ ...config, assistant: { ...config.assistant, automaticMemory: 'false' } })
				.ok
		).toBe(false);
		const existing = parseStackConfig({
			...config,
			assistant: { bindAddress: '127.0.0.1', port: 3810 }
		});
		expect(existing.ok && existing.config.assistant).toMatchObject({
			timezone: hostTimezone(),
			automaticMemory: true
		});
	});

	it('rejects invalid versions, binds, credentials, and portal references', () => {
		expect(parseStackConfig({ version: 2 })).toEqual({
			ok: false,
			error: 'stack config must use version 1'
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
		const invalidAccess = defaultStackConfig();
		invalidAccess.portals.discord.access.users = ['not-a-snowflake'];
		expect(parseStackConfig(invalidAccess)).toEqual({
			ok: false,
			error: 'discord users contains an invalid platform ID'
		});
		expect(parseStackConfig({ ...defaultStackConfig(), unsupported: true })).toEqual({
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

	it('requires an explicit stack config instead of inferring environment intent', () => {
		const root = home();
		mkdirSync(join(root, 'state'), { recursive: true });
		writeFileSync(
			join(root, 'state', 'stack.env'),
			[
				'OP_ENABLED_ADDONS=gateway,discord',
				'OP_ASSISTANT_BIND_ADDRESS=192.168.1.12',
				'OP_ASSISTANT_PORT=4910',
				'OP_GUARDIAN_BIND_ADDRESS=0.0.0.0',
				''
			].join('\n')
		);
		const result = readStackConfig(root);
		expect(result).toEqual({
			ok: false,
			error: `stack config is missing: ${stackConfigFile(root)}`
		});
	});

	it('rejects unsupported config versions without mutating the file', () => {
		const root = home();
		mkdirSync(join(root, 'state'), { recursive: true });
		writeFileSync(
			stackConfigFile(root),
			JSON.stringify({
				version: 2,
				assistant: { bindAddress: '127.0.0.1', port: 3810 },
				gateway: { enabled: true, bindAddress: '127.0.0.1', port: 3830, policy: 'read' },
				portals: {
					discord: { enabled: false, policy: 'chat' },
					slack: { enabled: false, policy: 'full' }
				}
			})
		);
		const result = readStackConfig(root);
		expect(result).toEqual({ ok: false, error: 'stack config must use version 1' });
		expect(() => ensureStackConfig(root)).toThrow('stack config must use version 1');
		expect(JSON.parse(readFileSync(stackConfigFile(root), 'utf8')).version).toBe(2);

		writeFileSync(
			stackConfigFile(root),
			JSON.stringify({
				version: 2,
				gateway: { enabled: true, bindAddress: '127.0.0.1', port: 3830 },
				portals: { discord: { enabled: false }, slack: { enabled: false } }
			})
		);
		expect(readStackConfig(root)).toEqual({ ok: false, error: 'stack config must use version 1' });
	});

	it('atomically writes intent and derives runtime registry and portal selections', () => {
		const root = home();
		const config = defaultStackConfig();
		config.portals.slack.enabled = true;
		config.portals.slack.access.channels = ['C012ABCDEF'];
		writeStackConfig(root, config);

		expect(JSON.parse(readFileSync(stackConfigFile(root), 'utf8')).version).toBe(1);
		const registry = JSON.parse(readFileSync(credentialRegistryFile(root), 'utf8')) as {
			credentials: Array<{ username: string; policy: string }>;
		};
		expect(registry.credentials).toContainEqual({ username: 'owner', id: 'owner', policy: 'full' });
		const env = readFileSync(join(root, 'state', 'stack.env'), 'utf8');
		expect(env).toContain('OP_ENABLED_ADDONS=gateway,slack');
		expect(env).not.toContain('OP_DISCORD_CREDENTIAL=');
		expect(env).not.toContain('OP_SLACK_CREDENTIAL=');
		expect(env).toContain('SLACK_ALLOWED_CHANNELS=C012ABCDEF');
		expect(ensureStackConfig(root).portals.slack.enabled).toBe(true);
	});

	it('repairs derived runtime env from JSON source of truth', () => {
		const root = home();
		const config = defaultStackConfig();
		config.gateway.enabled = true;
		writeStackConfig(root, config);
		writeFileSync(
			join(root, 'state', 'stack.env'),
			'OP_ENABLED_ADDONS=unknown\nOP_ASSISTANT_PORT=9999\n'
		);

		ensureStackConfig(root);

		const env = readFileSync(join(root, 'state', 'stack.env'), 'utf8');
		expect(env).toContain('OP_ENABLED_ADDONS=gateway');
		expect(env).not.toContain('unknown');
		expect(env).toContain('OP_ASSISTANT_PORT=3810');
	});
});
