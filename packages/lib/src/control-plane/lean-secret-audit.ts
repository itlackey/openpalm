import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { readEnvFile, stackEnvFile } from './lean-foundation.js';
import { readStackConfig } from './stack-config.js';
import libPackage from '../../package.json' with { type: 'json' };

const SECRET_KEY = /(?:password|secret|token|api[_-]?key|credential|private[_-]?key)/i;
const RETIRED_SERVICE_NAMES = new Set([
	'api',
	'ollama',
	'paperclip',
	'remote',
	'tailscale',
	'ui',
	'voice',
	'workspace'
]);

const CORE_GRANTS: Readonly<Record<string, ReadonlySet<string>>> = {
	assistant: new Set(['opencode_server_password']),
	guardian: new Set(['guardian_handle_key', 'opencode_server_password']),
	discord: new Set(['discord_bot_token']),
	slack: new Set(['slack_bot_token', 'slack_app_token'])
};

const CORE_NETWORKS: Readonly<Record<string, ReadonlySet<string>>> = {
	assistant: new Set(['agent_net']),
	guardian: new Set(['agent_net', 'ingress_net']),
	discord: new Set(['ingress_net']),
	slack: new Set(['ingress_net'])
};

type MountGrant = {
	readonly source: string;
	readonly target: string;
	readonly readOnly: boolean;
};

const CORE_MOUNTS: Readonly<Record<string, readonly MountGrant[]>> = {
	assistant: [
		{ source: 'data/assistant', target: '/home/opencode', readOnly: false },
		{
			source: 'config/assistant',
			target: '/home/opencode/.config/opencode',
			readOnly: true
		},
		{
			source: 'knowledge/secrets/auth.json',
			target: '/home/opencode/.local/share/opencode/auth.json',
			readOnly: false
		},
		{ source: 'system/assistant', target: '/etc/opencode', readOnly: true },
		{ source: 'config/akm', target: '/etc/akm', readOnly: true },
		{ source: 'knowledge', target: '/stash', readOnly: false },
		{ source: 'data/akm/cache', target: '/opt/akm/cache', readOnly: false },
		{ source: 'data/akm/data', target: '/opt/akm/data', readOnly: false },
		{ source: 'workspace', target: '/work', readOnly: false }
	],
	guardian: [
		{ source: 'data/logs', target: '/opt/openpalm/logs', readOnly: false },
		{
			source: 'system/guardian',
			target: '/opt/openpalm/moderator-config',
			readOnly: true
		},
		{
			source: 'config/guardian',
			target: '/opt/openpalm/guardian/.config/opencode',
			readOnly: true
		},
		{
			source: 'knowledge/secrets/auth.json',
			target: '/opt/openpalm/guardian/.local/share/opencode/auth.json',
			readOnly: true
		},
		{ source: 'workspace', target: '/work', readOnly: true },
		{ source: 'state/credentials', target: '/run/openpalm-credentials', readOnly: true }
	],
	discord: [
		{ source: 'data/portal/discord', target: '/var/lib/openpalm', readOnly: false },
		{
			source: 'state/portal-credentials/discord',
			target: '/run/openpalm-credentials',
			readOnly: true
		}
	],
	slack: [
		{ source: 'data/portal/slack', target: '/var/lib/openpalm', readOnly: false },
		{
			source: 'state/portal-credentials/slack',
			target: '/run/openpalm-credentials',
			readOnly: true
		}
	]
};

const CORE_IMAGES = {
	assistant: { component: 'assistant', versionKey: 'OP_ASSISTANT_VERSION' },
	guardian: { component: 'guardian', versionKey: 'OP_GUARDIAN_VERSION' },
	discord: { component: 'portal', versionKey: 'OP_PORTAL_VERSION' },
	slack: { component: 'portal', versionKey: 'OP_PORTAL_VERSION' }
} as const;

const CORE_PROFILES: Readonly<Record<string, ReadonlySet<string>>> = {
	assistant: new Set(),
	guardian: new Set(['gateway', 'discord', 'slack']),
	discord: new Set(['discord']),
	slack: new Set(['slack'])
};

const MANAGED_SECRET_FILES: Readonly<Record<string, string>> = {
	opencode_server_password: 'state/secrets/op_opencode_password',
	guardian_handle_key: 'state/secrets/op_guardian_handle_key',
	discord_bot_token: 'state/secrets/discord_bot_token',
	slack_bot_token: 'state/secrets/slack_bot_token',
	slack_app_token: 'state/secrets/slack_app_token'
};

const FIXED_ENVIRONMENT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	assistant: {
		AKM_BUNDLE_DIR: '/stash',
		AKM_CACHE_DIR: '/opt/akm/cache',
		AKM_CONFIG_DIR: '/etc/akm',
		AKM_DATA_DIR: '/opt/akm/data',
		AKM_STATE_DIR: '/opt/akm/data/state',
		HOME: '/home/opencode',
		OPENCODE_CONFIG_DIR: '/etc/opencode',
		OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
		OPENCODE_DISABLE_CLAUDE_CODE: 'true',
		OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
		OPENCODE_DISABLE_EMBEDDED_WEB_UI: 'true',
		OPENCODE_API_URL: 'http://127.0.0.1:4096',
		OPENCODE_PORT: '4096',
		OPENCODE_SERVER_PASSWORD_FILE: '/run/secrets/opencode_server_password',
		TERM: 'xterm-256color'
	},
	guardian: {
		GUARDIAN_AUDIT_PATH: '/opt/openpalm/logs/guardian-audit.log',
		HOME: '/opt/openpalm/guardian',
		PORT: '8080',
		OPENCODE_CONFIG_DIR: '/opt/openpalm/moderator-config',
		OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
		OPENCODE_DISABLE_CLAUDE_CODE: 'true',
		OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
		OPENCODE_DISABLE_EMBEDDED_WEB_UI: 'true',
		OP_ASSISTANT_DIRECTORY: '/work',
		OP_ASSISTANT_URL: 'http://assistant:4096',
		OPENCODE_SERVER_PASSWORD_FILE: '/run/secrets/opencode_server_password',
		GUARDIAN_AUTH_DIR: '/run/openpalm-credentials',
		GUARDIAN_HANDLE_KEY_FILE: '/run/secrets/guardian_handle_key',
		GUARDIAN_OAUTH_CONFIG_FILE: '/opt/openpalm/guardian/.config/opencode/oauth.json',
		GUARDIAN_OAUTH_IDENTITIES_FILE:
			'/opt/openpalm/guardian/.config/opencode/oauth-identities.json',
		GUARDIAN_MODERATION_URL: 'http://127.0.0.1:4097',
		GUARDIAN_MODERATION_PORT: '4097',
		GUARDIAN_MODERATION_THRESHOLD: '3'
	},
	discord: {
		PORT: '8184',
		PORTAL_ADAPTER: 'discord',
		MCP_SERVER_URL: 'http://guardian:8080/mcp',
		PORTAL_CREDENTIALS_FILE: '/run/openpalm-credentials/credentials.json',
		DISCORD_BOT_TOKEN_FILE: '/run/secrets/discord_bot_token',
		PORTAL_STATE_PATH: '/var/lib/openpalm/portal.db'
	},
	slack: {
		PORT: '8185',
		PORTAL_ADAPTER: 'slack',
		MCP_SERVER_URL: 'http://guardian:8080/mcp',
		PORTAL_CREDENTIALS_FILE: '/run/openpalm-credentials/credentials.json',
		SLACK_BOT_TOKEN_FILE: '/run/secrets/slack_bot_token',
		SLACK_APP_TOKEN_FILE: '/run/secrets/slack_app_token',
		PORTAL_STATE_PATH: '/var/lib/openpalm/portal.db'
	}
};

const DYNAMIC_ENVIRONMENT: Readonly<Record<string, ReadonlySet<string>>> = {
	assistant: new Set(),
	guardian: new Set([
		'GUARDIAN_ALLOWED_ORIGINS',
		'GUARDIAN_ASSISTANT_TIMEOUT_MS',
		'GUARDIAN_MODERATION_TIMEOUT_MS'
	]),
	discord: new Set([
		'DISCORD_ALLOWED_GUILDS',
		'DISCORD_ALLOWED_ROLES',
		'DISCORD_ALLOWED_USERS',
		'DISCORD_BLOCKED_USERS'
	]),
	slack: new Set(['SLACK_ALLOWED_CHANNELS', 'SLACK_ALLOWED_USERS', 'SLACK_BLOCKED_USERS'])
};

const FORBIDDEN_CORE_ENVIRONMENT = new Set([
	'OPENCODE_CONFIG',
	'OPENCODE_CONFIG_CONTENT',
	'OPENCODE_PERMISSION'
]);

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function strings(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
	const object = record(value);
	return object ? Object.keys(object) : [];
}

function secretNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (typeof entry === 'string') return [entry];
		const object = record(entry);
		return typeof object?.source === 'string' ? [object.source] : [];
	});
}

function exactly(actual: Set<string>, expected: ReadonlySet<string>): boolean {
	return actual.size === expected.size && setDifference(actual, expected).length === 0;
}

function normalizedPath(path: string): string {
	const absolute = resolve(path);
	return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function isWithin(path: string, parent: string): boolean {
	const child = normalizedPath(path);
	const root = normalizedPath(parent);
	const result = relative(root, child);
	return result === '' || (!result.startsWith('..') && !isAbsolute(result));
}

function isRootUser(value: unknown): boolean {
	if (typeof value !== 'string' || !value.trim()) return true;
	const user = value.trim().split(':', 1)[0]?.toLowerCase();
	return user === '0' || user === 'root';
}

function volumeText(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => {
		if (typeof entry === 'string') return entry;
		const item = record(entry);
		return [item?.source, item?.target]
			.filter((part): part is string => typeof part === 'string')
			.join(':');
	});
}

function setDifference(actual: Set<string>, expected: ReadonlySet<string>): string[] {
	return [...actual].filter((value) => !expected.has(value));
}

function expectedImage(
	name: keyof typeof CORE_IMAGES,
	environment: Readonly<Record<string, string>>
): string {
	const definition = CORE_IMAGES[name];
	const namespace = environment.OP_IMAGE_NAMESPACE?.trim() || 'openpalm';
	const version = environment[definition.versionKey]?.trim() || libPackage.version;
	return `${namespace}/${definition.component}:${version}`;
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
	if (!Array.isArray(value) || value.length !== expected.length) return false;
	return value.every((item, index) => item === expected[index]);
}

function expectedHealthcheck(name: string): readonly string[] {
	switch (name) {
		case 'assistant':
			return [
				'CMD-SHELL',
				'curl -sf -u "opencode:$$(cat /run/secrets/opencode_server_password)" http://127.0.0.1:4096/config >/dev/null'
			];
		case 'guardian':
			return ['CMD', 'curl', '-sf', 'http://127.0.0.1:8080/health'];
		case 'discord':
			return ['CMD', 'curl', '-sf', 'http://127.0.0.1:8184/health'];
		case 'slack':
			return ['CMD', 'curl', '-sf', 'http://127.0.0.1:8185/health'];
		default:
			return [];
	}
}

function auditCoreMounts(
	name: string,
	value: unknown,
	homeDir: string,
	issues: string[],
	expected: readonly MountGrant[] = CORE_MOUNTS[name] ?? []
): void {
	const byTarget = new Map(expected.map((grant) => [grant.target, grant]));
	const found = new Set<string>();
	if (!Array.isArray(value)) {
		for (const grant of expected)
			issues.push(`service ${name} is missing required mount ${grant.target}`);
		return;
	}

	for (const rawMount of value) {
		const mount = record(rawMount);
		const target = typeof mount?.target === 'string' ? mount.target : '';
		const grant = byTarget.get(target);
		if (mount?.type !== 'bind' || typeof mount.source !== 'string' || !target) {
			issues.push(`service ${name} has an invalid mount`);
			continue;
		}
		if (!grant) {
			issues.push(`service ${name} has unexpected mount ${target}`);
			continue;
		}
		if (found.has(target)) {
			issues.push(`service ${name} mounts ${target} more than once`);
			continue;
		}
		found.add(target);
		if (normalizedPath(mount.source) !== normalizedPath(join(homeDir, grant.source))) {
			issues.push(`service ${name} must mount ${grant.source} at ${target}`);
		}
		if ((mount.read_only === true) !== grant.readOnly) {
			issues.push(
				`service ${name} mount ${target} must be ${grant.readOnly ? 'read-only' : 'read-write'}`
			);
		}
	}
	for (const grant of expected) {
		if (!found.has(grant.target))
			issues.push(`service ${name} is missing required mount ${grant.target}`);
	}
}

function auditCoreSecrets(name: string, value: unknown, issues: string[]): Set<string> {
	const expected = CORE_GRANTS[name] ?? new Set<string>();
	const granted = new Set(secretNames(value));
	for (const grant of setDifference(granted, expected)) {
		issues.push(`service ${name} has unexpected secret ${grant}`);
	}
	for (const grant of setDifference(new Set(expected), granted)) {
		issues.push(`service ${name} is missing required secret ${grant}`);
	}
	if (Array.isArray(value)) {
		for (const rawGrant of value) {
			const grant = record(rawGrant);
			if (!grant || typeof grant.source !== 'string') continue;
			if (grant.target !== `/run/secrets/${grant.source}`) {
				issues.push(`service ${name} secret ${grant.source} must use its managed target`);
			}
		}
	}
	return granted;
}

function auditCoreEnvironment(
	name: string,
	environment: Record<string, unknown>,
	issues: string[]
): void {
	const fixed = FIXED_ENVIRONMENT[name] ?? {};
	const dynamic = DYNAMIC_ENVIRONMENT[name] ?? new Set<string>();
	for (const key of FORBIDDEN_CORE_ENVIRONMENT) {
		if (environment[key] !== undefined) issues.push(`service ${name} may not set ${key}`);
	}
	for (const [key, expectedValue] of Object.entries(fixed)) {
		if (environment[key] !== expectedValue) {
			issues.push(`service ${name} must set ${key} to ${expectedValue}`);
		}
	}
	for (const key of Object.keys(environment)) {
		if (!Object.hasOwn(fixed, key) && !dynamic.has(key)) {
			issues.push(`service ${name} has unsupported environment key ${key}`);
		}
	}
	if (name === 'guardian') {
		const rawAssistantTimeout = environment.GUARDIAN_ASSISTANT_TIMEOUT_MS;
		const assistantTimeout =
			typeof rawAssistantTimeout === 'string' ? Number(rawAssistantTimeout) : Number.NaN;
		if (!Number.isInteger(assistantTimeout) || assistantTimeout < 1 || assistantTimeout > 300_000) {
			issues.push('service guardian assistant timeout must be an integer from 1 to 300000 ms');
		}
		const rawTimeout = environment.GUARDIAN_MODERATION_TIMEOUT_MS;
		const timeout = typeof rawTimeout === 'string' ? Number(rawTimeout) : Number.NaN;
		if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) {
			issues.push('service guardian moderation timeout must be an integer from 1 to 30000 ms');
		}
		const rawOrigins = environment.GUARDIAN_ALLOWED_ORIGINS;
		if (typeof rawOrigins !== 'string') {
			issues.push('service guardian must set GUARDIAN_ALLOWED_ORIGINS');
		} else {
			for (const rawOrigin of rawOrigins.split(',')) {
				const value = rawOrigin.trim();
				if (!value) continue;
				try {
					const url = new URL(value);
					if (
						value === '*' ||
						(url.protocol !== 'http:' && url.protocol !== 'https:') ||
						url.username ||
						url.password ||
						url.pathname !== '/' ||
						url.search ||
						url.hash
					) {
						throw new Error('invalid origin');
					}
				} catch {
					issues.push(`service guardian has invalid allowed origin ${value}`);
				}
			}
		}
	}
}

function portMatches(
	value: unknown,
	expected: { hostIp: string; published: string; target: number }
): boolean {
	const item = record(value);
	return (
		item?.host_ip === expected.hostIp &&
		String(item.published ?? '') === expected.published &&
		item.target === expected.target &&
		(item.protocol === undefined || item.protocol === 'tcp') &&
		(item.mode === undefined || item.mode === 'ingress')
	);
}

function isConfigured(value: unknown): boolean {
	if (value === undefined || value === null || value === false || value === '') return false;
	if (Array.isArray(value)) return value.length > 0;
	const object = record(value);
	return object ? Object.keys(object).length > 0 : true;
}

export function auditLeanCompose(config: unknown, homeDir: string): string[] {
	const root = record(config);
	const services = record(root?.services) ?? {};
	const secrets = record(root?.secrets) ?? {};
	const networks = record(root?.networks) ?? {};
	const stackEnvironment = readEnvFile(stackEnvFile(homeDir));
	const expectedUser = `${stackEnvironment.OP_UID?.trim() || '1000'}:${stackEnvironment.OP_GID?.trim() || '1000'}`;
	const projectName = stackEnvironment.OP_PROJECT_NAME?.trim() || 'openpalm';
	const stackConfig = readStackConfig(homeDir);
	const issues: string[] = [];

	for (const [name, rawDefinition] of Object.entries(secrets)) {
		const definition = record(rawDefinition);
		const file = definition?.file;
		if (typeof file !== 'string') {
			issues.push(`secret ${name} must use a file source`);
			continue;
		}
		if (!isWithin(file, homeDir)) issues.push(`secret ${name} escapes OP_HOME`);
		const managedSource = MANAGED_SECRET_FILES[name];
		if (managedSource && normalizedPath(file) !== normalizedPath(join(homeDir, managedSource))) {
			issues.push(`secret ${name} must use its managed file`);
		}
	}

	for (const [name, rawService] of Object.entries(services)) {
		const service = record(rawService) ?? {};
		const isCore = Object.hasOwn(CORE_GRANTS, name);
		if (RETIRED_SERVICE_NAMES.has(name)) {
			issues.push(`retired service ${name} must be removed or renamed in the custom overlay`);
		}
		if (service.env_file !== undefined) issues.push(`service ${name} may not use env_file`);
		if (service.privileged === true) issues.push(`service ${name} may not be privileged`);
		if (strings(service.cap_add).length > 0)
			issues.push(`service ${name} may not add capabilities`);
		if (service.network_mode === 'host') issues.push(`service ${name} may not use host networking`);
		else if (isConfigured(service.network_mode))
			issues.push(`service ${name} may not override network_mode`);
		if (service.pid === 'host') issues.push(`service ${name} may not share the host PID namespace`);
		else if (isConfigured(service.pid)) issues.push(`service ${name} may not override pid`);
		if (service.ipc === 'host') issues.push(`service ${name} may not share the host IPC namespace`);
		else if (isConfigured(service.ipc)) issues.push(`service ${name} may not override ipc`);
		for (const field of ['uts', 'userns', 'cgroup', 'credential_spec', 'volumes_from']) {
			if (isConfigured(service[field])) issues.push(`service ${name} may not set ${field}`);
		}
		if (Array.isArray(service.devices) && service.devices.length > 0) {
			issues.push(`service ${name} may not mount host devices`);
		}
		if (isConfigured(service.device_cgroup_rules)) {
			issues.push(`service ${name} may not set device_cgroup_rules`);
		}
		if (
			volumeText(service.volumes).some((volume) =>
				/(?:docker\.sock|containerd\.sock|\/run\/podman|\/var\/lib\/docker)/i.test(volume)
			)
		) {
			issues.push(`service ${name} may not mount a container runtime`);
		}
		const environment = record(service.environment) ?? {};
		if (isCore) auditCoreEnvironment(name, environment, issues);
		const granted = isCore
			? auditCoreSecrets(name, service.secrets, issues)
			: new Set(secretNames(service.secrets));
		for (const [key, value] of Object.entries(environment)) {
			if (SECRET_KEY.test(key) && !key.endsWith('_FILE')) {
				issues.push(`service ${name} exposes secret-like environment key ${key}`);
			}
			if (key.endsWith('_FILE') && typeof value === 'string' && value.startsWith('/run/secrets/')) {
				const referenced = value.slice('/run/secrets/'.length);
				if (!granted.has(referenced)) {
					issues.push(`service ${name} references ungranted secret ${referenced}`);
				}
			}
		}
		if (!isCore) {
			for (const grant of granted) {
				if (Object.hasOwn(MANAGED_SECRET_FILES, grant)) {
					issues.push(`service ${name} may not receive managed secret ${grant}`);
				}
			}
		}
		if (isCore) {
			if (service.init !== true) issues.push(`service ${name} must enable init`);
			if (isRootUser(service.user)) issues.push(`service ${name} must run as a non-root user`);
			else if (service.user !== expectedUser)
				issues.push(`service ${name} must run as ${expectedUser}`);
			const dropped = strings(service.cap_drop);
			if (dropped.length !== 1 || dropped[0]?.toUpperCase() !== 'ALL') {
				issues.push(`service ${name} must drop all capabilities`);
			}
			const securityOptions = strings(service.security_opt);
			if (
				securityOptions.length !== 1 ||
				!/^no-new-privileges(?::true)?$/i.test(securityOptions[0] ?? '')
			) {
				issues.push(`service ${name} must disable privilege escalation`);
			}
			const image = expectedImage(name as keyof typeof CORE_IMAGES, stackEnvironment);
			if (service.image !== image) {
				issues.push(`service ${name} must use managed image ${image}`);
			}
			if (isConfigured(service.build)) issues.push(`service ${name} may not define build`);
			if (isConfigured(service.command)) issues.push(`service ${name} may not override command`);
			if (isConfigured(service.entrypoint))
				issues.push(`service ${name} may not override entrypoint`);
			for (const field of [
				'configs',
				'develop',
				'dns',
				'dns_search',
				'extra_hosts',
				'external_links',
				'group_add',
				'hostname',
				'links',
				'post_start',
				'pre_stop'
			]) {
				if (isConfigured(service[field])) {
					issues.push(`service ${name} may not override ${field}`);
				}
			}
			const expectedProfiles = CORE_PROFILES[name] ?? new Set<string>();
			const profiles = new Set(strings(service.profiles));
			if (!exactly(profiles, expectedProfiles)) {
				issues.push(`service ${name} must retain its managed profiles`);
			}
			const healthcheck = record(service.healthcheck);
			if (
				healthcheck?.disable === true ||
				!exactStringArray(healthcheck?.test, expectedHealthcheck(name))
			) {
				issues.push(`service ${name} must retain its managed healthcheck`);
			}
			const logging = record(service.logging);
			const loggingOptions = record(logging?.options);
			if (
				logging?.driver !== 'json-file' ||
				loggingOptions?.['max-size'] !== '10m' ||
				loggingOptions?.['max-file'] !== '3'
			) {
				issues.push(`service ${name} must retain bounded local logging`);
			}
			auditCoreMounts(name, service.volumes, homeDir, issues);
		}
		const networks = new Set(strings(service.networks));
		if (networks.has('agent_net') && networks.has('ingress_net') && name !== 'guardian') {
			issues.push(`service ${name} may not bridge agent_net and ingress_net`);
		}
		if (!isCore && networks.has('agent_net')) {
			issues.push(`service ${name} may not join the private agent_net`);
		}
		const expectedNetworks = CORE_NETWORKS[name];
		if (expectedNetworks) {
			for (const network of setDifference(networks, expectedNetworks)) {
				issues.push(`service ${name} has unexpected network ${network}`);
			}
			for (const network of setDifference(new Set(expectedNetworks), networks)) {
				issues.push(`service ${name} is missing required network ${network}`);
			}
		}
		if (name === 'assistant') {
			const ports = Array.isArray(service.ports) ? service.ports : [];
			if (!stackConfig.ok) {
				issues.push(`assistant port cannot be audited: ${stackConfig.error}`);
			} else if (
				ports.length !== 1 ||
				!portMatches(ports[0], {
					hostIp: stackConfig.config.assistant.bindAddress,
					published: String(stackConfig.config.assistant.port),
					target: 4096
				})
			) {
				issues.push(
					`assistant must publish only ${stackConfig.config.assistant.bindAddress}:${stackConfig.config.assistant.port}:4096`
				);
			}
		}
		if (name === 'guardian') {
			const ports = Array.isArray(service.ports) ? service.ports : [];
			if (!stackConfig.ok) {
				issues.push(`guardian port cannot be audited: ${stackConfig.error}`);
			} else {
				if (
					ports.length !== 1 ||
					!portMatches(ports[0], {
						hostIp: stackConfig.config.gateway.bindAddress,
						published: String(stackConfig.config.gateway.port),
						target: 8080
					})
				) {
					issues.push(
						`guardian must publish only ${stackConfig.config.gateway.bindAddress}:${stackConfig.config.gateway.port}:8080`
					);
				}
			}
		}
		if (
			(name === 'discord' || name === 'slack') &&
			Array.isArray(service.ports) &&
			service.ports.length > 0
		) {
			issues.push(`service ${name} may not publish host ports`);
		}
	}

	const activeReservedNetworks = new Set<string>();
	for (const rawService of Object.values(services)) {
		const service = record(rawService);
		for (const name of strings(service?.networks)) {
			if (name === 'agent_net' || name === 'ingress_net') activeReservedNetworks.add(name);
		}
	}
	for (const name of activeReservedNetworks) {
		const definition = record(networks[name]);
		if (!definition) {
			issues.push(`managed network ${name} is missing`);
			continue;
		}
		if (definition.external === true) issues.push(`managed network ${name} may not be external`);
		if (definition.name !== `${projectName}_${name}`) {
			issues.push(`managed network ${name} must remain project-scoped`);
		}
		if (definition.driver !== undefined && definition.driver !== 'bridge') {
			issues.push(`managed network ${name} must use the bridge driver`);
		}
		if (definition.attachable === true)
			issues.push(`managed network ${name} may not be attachable`);
	}
	if (!Object.hasOwn(services, 'assistant')) issues.push('assistant service is required');
	return issues;
}
