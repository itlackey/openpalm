import { defineCommand } from 'citty';

import {
	parseStackConfig,
	ensureCredentialKeys,
	ensureOAuthFiles,
	OAUTH_ALGORITHMS,
	readOAuthConfig,
	readStackConfig,
	requireLeanInstall,
	resolveOpenPalmHome,
	stackConfigFile,
	syncPortalCredentialBundles,
	writeStackConfig,
	writeOAuthConfig,
	type OAuthAlgorithm,
	type OAuthConfig,
	type StackConfig
} from '@openpalm/lib/lean';

import { runRestartAction, runStartAction } from './lifecycle-lean.js';

function current() {
	const homeDir = resolveOpenPalmHome();
	requireLeanInstall(homeDir);
	const result = readStackConfig(homeDir);
	if (!result.ok) throw new Error(result.error);
	ensureOAuthFiles(homeDir);
	return { homeDir, config: result.config };
}

function isLoopback(address: string): boolean {
	return address === '::1' || address.startsWith('127.');
}

function warnExposure(label: string, address: string): void {
	if (isLoopback(address)) return;
	console.warn(
		`Warning: ${label} will be reachable beyond loopback at ${address}. Use a trusted network and TLS termination.`
	);
}

async function save(homeDir: string, config: StackConfig, apply: boolean): Promise<StackConfig> {
	const parsed = parseStackConfig(config);
	if (!parsed.ok) throw new Error(parsed.error);
	writeStackConfig(homeDir, parsed.config);
	ensureCredentialKeys(homeDir, parsed.config);
	syncPortalCredentialBundles(homeDir, parsed.config);
	if (apply) await runStartAction();
	return parsed.config;
}

const show = defineCommand({
	meta: { name: 'show', description: 'Print the effective StackConfigV2 JSON' },
	run() {
		console.log(JSON.stringify(current().config, null, 2));
	}
});

const path = defineCommand({
	meta: { name: 'path', description: 'Print the authoritative stack config path' },
	run() {
		console.log(stackConfigFile(resolveOpenPalmHome()));
	}
});

const gateway = defineCommand({
	meta: { name: 'gateway', description: 'Set the Guardian MCP bind address or port' },
	args: {
		bind: { type: 'string', description: 'exact IPv4 or IPv6 address' },
		port: { type: 'string', description: 'TCP port (1-65535)' },
		apply: {
			type: 'boolean',
			description: 'Apply the stack immediately (use --no-apply to defer)',
			default: true
		}
	},
	async run({ args }) {
		if (!args.bind && !args.port) throw new Error('Pass --bind, --port, or both.');
		const { homeDir, config } = current();
		if (args.bind) config.gateway.bindAddress = String(args.bind);
		if (args.port) config.gateway.port = Number(args.port);
		warnExposure('Guardian MCP', config.gateway.bindAddress);
		const written = await save(homeDir, config, args.apply !== false);
		console.log(JSON.stringify(written.gateway, null, 2));
	}
});

const assistant = defineCommand({
	meta: { name: 'assistant', description: 'Set the native OpenCode bind address or port' },
	args: {
		bind: { type: 'string', description: 'exact IPv4 or IPv6 address' },
		port: { type: 'string', description: 'TCP port (1-65535)' },
		apply: {
			type: 'boolean',
			description: 'Apply the stack immediately (use --no-apply to defer)',
			default: true
		}
	},
	async run({ args }) {
		if (!args.bind && !args.port) throw new Error('Pass --bind, --port, or both.');
		const { homeDir, config } = current();
		if (args.bind) config.assistant.bindAddress = String(args.bind);
		if (args.port) config.assistant.port = Number(args.port);
		warnExposure('the native OpenCode API', config.assistant.bindAddress);
		const written = await save(homeDir, config, args.apply !== false);
		console.log(JSON.stringify(written.assistant, null, 2));
	}
});

const portal = defineCommand({
	meta: { name: 'portal', description: 'Select the named credential used by a portal' },
	args: {
		name: {
			type: 'positional',
			required: true,
			description: 'discord or slack'
		},
		credential: {
			type: 'string',
			required: true,
			description: 'named credential username'
		},
		apply: {
			type: 'boolean',
			description: 'Apply the stack immediately (use --no-apply to defer)',
			default: true
		}
	},
	async run({ args }) {
		const name = String(args._?.[0] ?? '');
		if (name !== 'discord' && name !== 'slack') {
			throw new Error('Unknown portal. Choose: discord or slack.');
		}
		const credential = String(args.credential ?? '');
		const { homeDir, config } = current();
		if (!Object.hasOwn(config.credentials, credential)) {
			throw new Error(`Unknown credential: ${credential}. Create it first.`);
		}
		config.portals[name].credential = credential;
		const written = await save(homeDir, config, args.apply !== false);
		console.log(`${name}: ${written.portals[name].credential}`);
	}
});

function commaList(value: unknown): string[] {
	return String(value)
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

const oauth = defineCommand({
	meta: { name: 'oauth', description: 'Configure Guardian as an OAuth MCP resource server' },
	args: {
		disable: { type: 'boolean', description: 'disable OAuth bearer-token authentication' },
		resource: { type: 'string', description: 'public HTTPS MCP resource URL' },
		issuer: { type: 'string', description: 'authorization server issuer URL' },
		jwksUrl: { type: 'string', description: 'authorization server JWKS URL' },
		audience: { type: 'string', description: 'required access-token audience' },
		scopes: { type: 'string', description: 'comma-separated required scopes' },
		algorithms: { type: 'string', description: 'comma-separated JWT algorithms' },
		apply: {
			type: 'boolean',
			description: 'recreate the stack immediately (use --no-apply to defer)',
			default: true
		}
	},
	async run({ args }) {
		const { homeDir } = current();
		const existing = readOAuthConfig(homeDir);
		const hasSettings = Boolean(
			args.resource ||
				args.issuer ||
				args.jwksUrl ||
				args.audience ||
				args.scopes ||
				args.algorithms
		);
		if (!args.disable && !hasSettings) {
			console.log(JSON.stringify(existing, null, 2));
			return;
		}
		if (args.disable && hasSettings) {
			throw new Error('Use --disable by itself; OAuth settings are ignored only after removal.');
		}
		let next: OAuthConfig;
		if (args.disable) {
			next = { version: 1, enabled: false };
		} else {
			const previous = existing.enabled ? existing : null;
			const resource = String(args.resource ?? previous?.resource ?? '');
			const issuer = String(args.issuer ?? previous?.issuer ?? '');
			const jwksUrl = String(args.jwksUrl ?? previous?.jwksUrl ?? '');
			if (!resource || !issuer || !jwksUrl) {
				throw new Error('Enabling OAuth requires --resource, --issuer, and --jwks-url.');
			}
			const algorithms = args.algorithms
				? commaList(args.algorithms)
				: (previous?.algorithms ?? ['RS256']);
			if (!algorithms.every((value) => OAUTH_ALGORITHMS.includes(value as OAuthAlgorithm))) {
				throw new Error(`Algorithms must be one of: ${OAUTH_ALGORITHMS.join(', ')}.`);
			}
			next = {
				version: 1,
				enabled: true,
				resource,
				issuer,
				jwksUrl,
				audience: String(args.audience ?? previous?.audience ?? resource),
				scopes: args.scopes ? commaList(args.scopes) : (previous?.scopes ?? ['openpalm']),
				algorithms: algorithms as OAuthAlgorithm[]
			};
		}
		const written = writeOAuthConfig(homeDir, next);
		console.log(JSON.stringify(written, null, 2));
		if (args.apply !== false) await runRestartAction();
	}
});

export default defineCommand({
	meta: { name: 'config', description: 'Inspect or change the lean stack intent' },
	subCommands: { show, path, assistant, gateway, portal, oauth }
});
