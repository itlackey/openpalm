import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

import {
	mergeEnvContent,
	readEnvFile,
	stackConfigFile,
	stackEnvFile,
	writeFileAtomic
} from './lean-foundation.js';

export { stackConfigFile } from './lean-foundation.js';

export const STACK_CONFIG_VERSION = 2 as const;
export const CREDENTIAL_REGISTRY_VERSION = 1 as const;

export const GUARDIAN_POLICIES = ['chat', 'read', 'full'] as const;
export type GuardianPolicy = (typeof GUARDIAN_POLICIES)[number];

export type CredentialConfig = {
	id: string;
	policy: GuardianPolicy;
};

export type StackConfig = {
	version: typeof STACK_CONFIG_VERSION;
	assistant: {
		bindAddress: string;
		port: number;
	};
	gateway: {
		enabled: boolean;
		bindAddress: string;
		port: number;
	};
	credentials: Record<string, CredentialConfig>;
	portals: {
		discord: { enabled: boolean; credential: string };
		slack: { enabled: boolean; credential: string };
	};
};

export type StackConfigReadResult =
	| { ok: true; config: StackConfig; source: 'file' | 'v1' | 'legacy-env' }
	| { ok: false; error: string };

const DEFAULT_BIND_ADDRESS = '127.0.0.1';
const DEFAULT_ASSISTANT_PORT = 3810;
const DEFAULT_GATEWAY_PORT = 3830;
const MAX_CREDENTIALS = 128;
const LEAN_ADDONS = new Set(['gateway', 'discord', 'slack']);
const USERNAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const CREDENTIAL_ID_RE = /^(?:owner|discord|slack|cred_[a-f0-9]{32})$/;
const RETIRED_POLICY_ENV = new Set([
	'GUARDIAN_OWNER_POLICY',
	'GUARDIAN_DISCORD_POLICY',
	'GUARDIAN_SLACK_POLICY'
]);

const DEFAULT_POLICIES = {
	owner: 'full',
	discord: 'chat',
	slack: 'chat'
} as const satisfies Record<string, GuardianPolicy>;

export function isCredentialUsername(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		USERNAME_RE.test(value) &&
		value !== 'constructor' &&
		value !== 'prototype'
	);
}

export function isCredentialId(value: unknown): value is string {
	return typeof value === 'string' && CREDENTIAL_ID_RE.test(value);
}

export function createCredentialId(): string {
	return `cred_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('')}`;
}

export function defaultStackConfig(): StackConfig {
	return {
		version: STACK_CONFIG_VERSION,
		assistant: {
			bindAddress: DEFAULT_BIND_ADDRESS,
			port: DEFAULT_ASSISTANT_PORT
		},
		gateway: {
			enabled: false,
			bindAddress: DEFAULT_BIND_ADDRESS,
			port: DEFAULT_GATEWAY_PORT
		},
		credentials: {
			owner: { id: 'owner', policy: DEFAULT_POLICIES.owner },
			discord: { id: 'discord', policy: DEFAULT_POLICIES.discord },
			slack: { id: 'slack', policy: DEFAULT_POLICIES.slack }
		},
		portals: {
			discord: { enabled: false, credential: 'discord' },
			slack: { enabled: false, credential: 'slack' }
		}
	};
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function parsePort(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
		? value
		: null;
}

function validBindAddress(value: string): boolean {
	return isIP(value) !== 0;
}

export function isGuardianPolicy(value: unknown): value is GuardianPolicy {
	return typeof value === 'string' && GUARDIAN_POLICIES.includes(value as GuardianPolicy);
}

function parseCredentials(
	value: unknown
): { ok: true; value: Record<string, CredentialConfig> } | { ok: false; error: string } {
	const source = asRecord(value);
	if (!source) return { ok: false, error: 'credentials must be an object keyed by username' };
	const entries = Object.entries(source);
	if (entries.length < 1 || entries.length > MAX_CREDENTIALS) {
		return {
			ok: false,
			error: `credentials must contain between 1 and ${MAX_CREDENTIALS} entries`
		};
	}
	const result: Record<string, CredentialConfig> = {};
	const ids = new Set<string>();
	for (const [username, rawCredential] of entries) {
		if (!isCredentialUsername(username)) {
			return { ok: false, error: `invalid credential username: ${username}` };
		}
		const credential = asRecord(rawCredential);
		if (!credential || !hasOnlyKeys(credential, ['id', 'policy'])) {
			return { ok: false, error: `credential ${username} contains unsupported settings` };
		}
		if (!isCredentialId(credential.id)) {
			return { ok: false, error: `credential ${username} has an invalid id` };
		}
		if (ids.has(credential.id)) {
			return { ok: false, error: `credential id is duplicated: ${credential.id}` };
		}
		if (!isGuardianPolicy(credential.policy)) {
			return {
				ok: false,
				error: `credential ${username} policy must be one of: ${GUARDIAN_POLICIES.join(', ')}`
			};
		}
		ids.add(credential.id);
		result[username] = { id: credential.id, policy: credential.policy };
	}
	return { ok: true, value: result };
}

export function parseStackConfig(value: unknown): StackConfigReadResult {
	const root = asRecord(value);
	if (!root || root.version !== STACK_CONFIG_VERSION) {
		return { ok: false, error: `stack config must use version ${STACK_CONFIG_VERSION}` };
	}

	const assistant = asRecord(root.assistant);
	const gateway = asRecord(root.gateway);
	const portals = asRecord(root.portals);
	const discord = asRecord(portals?.discord);
	const slack = asRecord(portals?.slack);
	if (!assistant || !gateway || !portals || !discord || !slack) {
		return { ok: false, error: 'stack config is missing assistant, gateway, or portal settings' };
	}
	if (
		!hasOnlyKeys(root, ['version', 'assistant', 'gateway', 'credentials', 'portals']) ||
		!hasOnlyKeys(assistant, ['bindAddress', 'port']) ||
		!hasOnlyKeys(gateway, ['enabled', 'bindAddress', 'port']) ||
		!hasOnlyKeys(portals, ['discord', 'slack']) ||
		!hasOnlyKeys(discord, ['enabled', 'credential']) ||
		!hasOnlyKeys(slack, ['enabled', 'credential'])
	) {
		return { ok: false, error: 'stack config contains unsupported settings' };
	}

	const assistantPort = parsePort(assistant.port);
	const gatewayPort = parsePort(gateway.port);
	if (typeof assistant.bindAddress !== 'string' || !validBindAddress(assistant.bindAddress)) {
		return { ok: false, error: 'assistant.bindAddress must be an IPv4 or IPv6 address' };
	}
	if (assistantPort === null) {
		return { ok: false, error: 'assistant.port must be an integer between 1 and 65535' };
	}
	if (typeof gateway.enabled !== 'boolean') {
		return { ok: false, error: 'gateway.enabled must be a boolean' };
	}
	if (typeof gateway.bindAddress !== 'string' || !validBindAddress(gateway.bindAddress)) {
		return { ok: false, error: 'gateway.bindAddress must be an IPv4 or IPv6 address' };
	}
	if (gatewayPort === null) {
		return { ok: false, error: 'gateway.port must be an integer between 1 and 65535' };
	}
	if (typeof discord.enabled !== 'boolean' || typeof slack.enabled !== 'boolean') {
		return { ok: false, error: 'portal enabled values must be booleans' };
	}
	if (!isCredentialUsername(discord.credential) || !isCredentialUsername(slack.credential)) {
		return { ok: false, error: 'portal credential values must be valid credential usernames' };
	}
	const credentials = parseCredentials(root.credentials);
	if (!credentials.ok) return credentials;
	if (
		!Object.hasOwn(credentials.value, discord.credential) ||
		!Object.hasOwn(credentials.value, slack.credential)
	) {
		return { ok: false, error: 'every portal credential must reference a configured credential' };
	}

	const config: StackConfig = {
		version: STACK_CONFIG_VERSION,
		assistant: { bindAddress: assistant.bindAddress, port: assistantPort },
		gateway: {
			enabled: gateway.enabled || discord.enabled || slack.enabled,
			bindAddress: gateway.bindAddress,
			port: gatewayPort
		},
		credentials: credentials.value,
		portals: {
			discord: { enabled: discord.enabled, credential: discord.credential },
			slack: { enabled: slack.enabled, credential: slack.credential }
		}
	};
	return { ok: true, config, source: 'file' };
}

function policy(value: unknown, fallback: GuardianPolicy): GuardianPolicy {
	return isGuardianPolicy(value) ? value : fallback;
}

function setDefaultCredentialPolicy(
	config: StackConfig,
	username: keyof typeof DEFAULT_POLICIES,
	value: GuardianPolicy
): void {
	const credential = config.credentials[username];
	if (!credential) throw new Error(`default credential is missing: ${username}`);
	credential.policy = value;
}

function migrateV1(value: unknown): StackConfig | null {
	const root = asRecord(value);
	const assistant = asRecord(root?.assistant);
	const gateway = asRecord(root?.gateway);
	const portals = asRecord(root?.portals);
	const discord = asRecord(portals?.discord);
	const slack = asRecord(portals?.slack);
	if (
		root?.version !== 1 ||
		!gateway ||
		!portals ||
		!discord ||
		!slack ||
		!hasOnlyKeys(root, ['version', 'assistant', 'gateway', 'portals']) ||
		!hasOnlyKeys(gateway, ['enabled', 'bindAddress', 'port', 'policy']) ||
		!hasOnlyKeys(portals, ['discord', 'slack']) ||
		!hasOnlyKeys(discord, ['enabled', 'policy']) ||
		!hasOnlyKeys(slack, ['enabled', 'policy']) ||
		(assistant !== null && !hasOnlyKeys(assistant, ['bindAddress', 'port']))
	) {
		return null;
	}
	const candidate = defaultStackConfig();
	if (assistant) {
		candidate.assistant.bindAddress = assistant.bindAddress as string;
		candidate.assistant.port = assistant.port as number;
	}
	candidate.gateway.enabled = gateway.enabled as boolean;
	candidate.gateway.bindAddress = gateway.bindAddress as string;
	candidate.gateway.port = gateway.port as number;
	setDefaultCredentialPolicy(candidate, 'owner', policy(gateway.policy, DEFAULT_POLICIES.owner));
	candidate.portals.discord.enabled = discord.enabled as boolean;
	setDefaultCredentialPolicy(
		candidate,
		'discord',
		policy(discord.policy, DEFAULT_POLICIES.discord)
	);
	candidate.portals.slack.enabled = slack.enabled as boolean;
	setDefaultCredentialPolicy(candidate, 'slack', policy(slack.policy, DEFAULT_POLICIES.slack));
	const parsed = parseStackConfig(candidate);
	return parsed.ok ? parsed.config : null;
}

function legacyConfig(homeDir: string): StackConfig {
	const env = readEnvFile(stackEnvFile(homeDir));
	const enabled = new Set(parseAddons(env.OP_ENABLED_ADDONS));
	const discord = enabled.has('discord');
	const slack = enabled.has('slack');
	const oldGateway =
		enabled.has('gateway') ||
		enabled.has('api') ||
		env.OP_ACCESS_GUARDIAN === 'true' ||
		env.OP_ACCESS_OPENAI_API === 'true' ||
		env.GUARDIAN_DIRECT_INGRESS === 'true';
	const rawPort = Number.parseInt(env.OP_GUARDIAN_PORT ?? '', 10);
	const rawAssistantPort = Number.parseInt(env.OP_ASSISTANT_PORT ?? '', 10);
	const bindAddress = env.OP_GUARDIAN_BIND_ADDRESS?.trim() || DEFAULT_BIND_ADDRESS;
	const assistantBindAddress = env.OP_ASSISTANT_BIND_ADDRESS?.trim() || DEFAULT_BIND_ADDRESS;
	const config = defaultStackConfig();
	config.assistant.bindAddress = validBindAddress(assistantBindAddress)
		? assistantBindAddress
		: DEFAULT_BIND_ADDRESS;
	config.assistant.port = parsePort(rawAssistantPort) ?? DEFAULT_ASSISTANT_PORT;
	config.gateway.enabled = oldGateway || discord || slack;
	config.gateway.bindAddress = validBindAddress(bindAddress) ? bindAddress : DEFAULT_BIND_ADDRESS;
	config.gateway.port = parsePort(rawPort) ?? DEFAULT_GATEWAY_PORT;
	setDefaultCredentialPolicy(
		config,
		'owner',
		policy(env.GUARDIAN_OWNER_POLICY, DEFAULT_POLICIES.owner)
	);
	setDefaultCredentialPolicy(
		config,
		'discord',
		policy(env.GUARDIAN_DISCORD_POLICY, DEFAULT_POLICIES.discord)
	);
	setDefaultCredentialPolicy(
		config,
		'slack',
		policy(env.GUARDIAN_SLACK_POLICY, DEFAULT_POLICIES.slack)
	);
	config.portals.discord.enabled = discord;
	config.portals.slack.enabled = slack;
	return config;
}

export function readStackConfig(homeDir: string): StackConfigReadResult {
	const path = stackConfigFile(homeDir);
	if (!existsSync(path)) {
		return { ok: true, config: legacyConfig(homeDir), source: 'legacy-env' };
	}
	try {
		const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
		const parsed = parseStackConfig(value);
		if (parsed.ok) return parsed;
		const migrated = migrateV1(value);
		return migrated ? { ok: true, config: migrated, source: 'v1' } : parsed;
	} catch (error) {
		return {
			ok: false,
			error: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}

export function credentialRegistryFile(homeDir: string): string {
	return join(homeDir, 'state', 'credentials', 'registry.json');
}

function writeCredentialRegistry(homeDir: string, config: StackConfig): void {
	const credentials = Object.entries(config.credentials)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([username, credential]) => ({ username, ...credential }));
	writeFileAtomic(
		credentialRegistryFile(homeDir),
		`${JSON.stringify({ version: CREDENTIAL_REGISTRY_VERSION, credentials }, null, 2)}\n`,
		0o600
	);
}

export function stackConfigEnv(config: StackConfig): Record<string, string> {
	const addons: string[] = [];
	if (config.gateway.enabled) addons.push('gateway');
	if (config.portals.discord.enabled) addons.push('discord');
	if (config.portals.slack.enabled) addons.push('slack');

	return {
		OP_STACK_CONFIG_VERSION: String(config.version),
		OP_ENABLED_ADDONS: [...new Set(addons)].join(','),
		OP_ASSISTANT_BIND_ADDRESS: config.assistant.bindAddress,
		OP_ASSISTANT_PORT: String(config.assistant.port),
		OP_GUARDIAN_BIND_ADDRESS: config.gateway.bindAddress,
		OP_GUARDIAN_PORT: String(config.gateway.port),
		OP_DISCORD_CREDENTIAL: config.portals.discord.credential,
		OP_SLACK_CREDENTIAL: config.portals.slack.credential
	};
}

function withoutRetiredPolicyEnv(content: string): string {
	return content
		.split(/\r?\n/)
		.filter((line) => {
			const candidate = line.trimStart().replace(/^export\s+/, '');
			const separator = candidate.indexOf('=');
			return separator <= 0 || !RETIRED_POLICY_ENV.has(candidate.slice(0, separator).trim());
		})
		.join('\n');
}

export function writeStackConfig(homeDir: string, value: StackConfig): StackConfig {
	const parsed = parseStackConfig(value);
	if (!parsed.ok) throw new Error(parsed.error);

	const config = parsed.config;
	writeFileAtomic(stackConfigFile(homeDir), `${JSON.stringify(config, null, 2)}\n`, 0o600);
	writeCredentialRegistry(homeDir, config);

	const envPath = stackEnvFile(homeDir);
	const current = withoutRetiredPolicyEnv(existsSync(envPath) ? readFileSync(envPath, 'utf8') : '');
	writeFileAtomic(envPath, mergeEnvContent(current, stackConfigEnv(config)), 0o600);
	return config;
}

export function ensureStackConfig(homeDir: string): StackConfig {
	const result = readStackConfig(homeDir);
	if (!result.ok) throw new Error(result.error);
	if (result.source === 'file') {
		const envPath = stackEnvFile(homeDir);
		const raw = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
		const current = withoutRetiredPolicyEnv(raw);
		const next = mergeEnvContent(current, stackConfigEnv(result.config));
		if (next !== raw) writeFileAtomic(envPath, next, 0o600);
		writeCredentialRegistry(homeDir, result.config);
		return result.config;
	}
	return writeStackConfig(homeDir, result.config);
}

export function leanEnabledAddons(homeDir: string): string[] {
	const result = readStackConfig(homeDir);
	if (!result.ok) throw new Error(result.error);
	return parseAddons(stackConfigEnv(result.config).OP_ENABLED_ADDONS).filter((addon) =>
		LEAN_ADDONS.has(addon)
	);
}

function parseAddons(value: string | undefined): string[] {
	return (value ?? '')
		.split(',')
		.map((item) => item.trim().toLowerCase())
		.filter((item, index, all) => item.length > 0 && all.indexOf(item) === index);
}
