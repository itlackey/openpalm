import { defineCommand } from 'citty';
import { readFileSync } from 'node:fs';

import {
	createCredentialId,
	ensureCredentialKeys,
	generateCredentialKey,
	isCredentialUsername,
	isGuardianPolicy,
	normalizeCredentialKey,
	readCredentialKey,
	readStackConfig,
	removeCredentialKey,
	requireLeanInstall,
	resolveOpenPalmHome,
	writeCredentialKey,
	writeStackConfig,
	type GuardianPolicy,
	type StackConfig
} from '@openpalm/lib/lean';

function current(): { homeDir: string; config: StackConfig } {
	const homeDir = resolveOpenPalmHome();
	requireLeanInstall(homeDir);
	const result = readStackConfig(homeDir);
	if (!result.ok) throw new Error(result.error);
	ensureCredentialKeys(homeDir, result.config);
	return { homeDir, config: result.config };
}

function positional(args: { _?: unknown[] }, index: number): string {
	return String(args._?.[index] ?? '');
}

function requireUsername(value: string): string {
	if (!isCredentialUsername(value)) {
		throw new Error(
			'Credential usernames must start with a lowercase letter and contain only lowercase letters, numbers, dots, underscores, or hyphens (maximum 64 characters).'
		);
	}
	return value;
}

function requirePolicy(value: string): GuardianPolicy {
	if (!isGuardianPolicy(value)) throw new Error('Policy must be chat, read, or full.');
	return value;
}

function suppliedKey(path: string | undefined): string {
	if (!path) return generateCredentialKey();
	const content = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
	return normalizeCredentialKey(content);
}

function rejectDuplicateKey(
	homeDir: string,
	config: StackConfig,
	key: string,
	exceptUsername?: string
): void {
	for (const username of Object.keys(config.credentials)) {
		if (username === exceptUsername) continue;
		if (readCredentialKey(homeDir, username) === key) {
			throw new Error(`Credential key is already assigned to ${username}.`);
		}
	}
}

const list = defineCommand({
	meta: { name: 'list', description: 'List credential usernames and policies without keys' },
	run() {
		const { config } = current();
		for (const [username, credential] of Object.entries(config.credentials).sort(([a], [b]) =>
			a.localeCompare(b)
		)) {
			const portals = (['discord', 'slack'] as const).filter(
				(name) => config.portals[name].credential === username
			);
			console.log(
				`${username}\t${credential.policy}${portals.length ? `\tportals=${portals.join(',')}` : ''}`
			);
		}
	}
});

const add = defineCommand({
	meta: { name: 'add', description: 'Create a named Guardian/MCP credential' },
	args: {
		username: { type: 'positional', required: true },
		policy: { type: 'positional', required: true, description: 'chat, read, or full' },
		keyFile: {
			type: 'string',
			description: 'read the key from this file; use - for stdin (generated when omitted)'
		},
		showKey: {
			type: 'boolean',
			description: 'print the key once after creating it',
			default: false
		}
	},
	run({ args }) {
		const username = requireUsername(positional(args, 0));
		const policy = requirePolicy(positional(args, 1));
		const { homeDir, config } = current();
		if (Object.hasOwn(config.credentials, username)) {
			throw new Error(`Credential already exists: ${username}`);
		}
		if (Object.keys(config.credentials).length >= 128) {
			throw new Error('Credential limit reached (128).');
		}
		const key = suppliedKey(args.keyFile ? String(args.keyFile) : undefined);
		rejectDuplicateKey(homeDir, config, key);
		writeCredentialKey(homeDir, username, key);
		config.credentials[username] = { id: createCredentialId(), policy };
		writeStackConfig(homeDir, config);
		console.log(`Created ${username} with ${policy} policy.`);
		console.log(`Key file: ${homeDir}/state/credentials/${username}/key`);
		if (args.showKey) console.log(key);
	}
});

const setPolicy = defineCommand({
	meta: { name: 'set-policy', description: 'Change a named credential policy' },
	args: {
		username: { type: 'positional', required: true },
		policy: { type: 'positional', required: true, description: 'chat, read, or full' }
	},
	run({ args }) {
		const username = requireUsername(positional(args, 0));
		const policy = requirePolicy(positional(args, 1));
		const { homeDir, config } = current();
		const credential = Object.hasOwn(config.credentials, username)
			? config.credentials[username]
			: undefined;
		if (!credential) throw new Error(`Unknown credential: ${username}`);
		credential.policy = policy;
		writeStackConfig(homeDir, config);
		console.log(`${username}: ${policy}`);
	}
});

const rotate = defineCommand({
	meta: { name: 'rotate', description: 'Replace a named credential key without changing identity' },
	args: {
		username: { type: 'positional', required: true },
		keyFile: {
			type: 'string',
			description: 'read the new key from this file; use - for stdin (generated when omitted)'
		},
		showKey: {
			type: 'boolean',
			description: 'print the new key once',
			default: false
		}
	},
	run({ args }) {
		const username = requireUsername(positional(args, 0));
		const { homeDir, config } = current();
		if (!Object.hasOwn(config.credentials, username)) {
			throw new Error(`Unknown credential: ${username}`);
		}
		const key = suppliedKey(args.keyFile ? String(args.keyFile) : undefined);
		rejectDuplicateKey(homeDir, config, key, username);
		writeCredentialKey(homeDir, username, key);
		console.log(`Rotated ${username}.`);
		console.log(`Key file: ${homeDir}/state/credentials/${username}/key`);
		if (args.showKey) console.log(key);
	}
});

const show = defineCommand({
	meta: { name: 'show', description: 'Show credential metadata and optionally its key' },
	args: {
		username: { type: 'positional', required: true },
		showKey: { type: 'boolean', description: 'include the secret key', default: false }
	},
	run({ args }) {
		const username = requireUsername(positional(args, 0));
		const { homeDir, config } = current();
		const credential = Object.hasOwn(config.credentials, username)
			? config.credentials[username]
			: undefined;
		if (!credential) throw new Error(`Unknown credential: ${username}`);
		console.log(
			JSON.stringify(
				{
					username,
					policy: credential.policy,
					keyFile: `${homeDir}/state/credentials/${username}/key`,
					...(args.showKey ? { key: readCredentialKey(homeDir, username) } : {})
				},
				null,
				2
			)
		);
	}
});

const remove = defineCommand({
	meta: { name: 'remove', description: 'Revoke and remove a named credential' },
	args: { username: { type: 'positional', required: true } },
	run({ args }) {
		const username = requireUsername(positional(args, 0));
		const { homeDir, config } = current();
		if (!Object.hasOwn(config.credentials, username)) {
			throw new Error(`Unknown credential: ${username}`);
		}
		for (const name of ['discord', 'slack'] as const) {
			if (config.portals[name].credential === username) {
				throw new Error(
					`Credential ${username} is assigned to ${name}. Assign another credential before removing it.`
				);
			}
		}
		if (Object.keys(config.credentials).length === 1) {
			throw new Error('Cannot remove the final credential.');
		}
		delete config.credentials[username];
		writeStackConfig(homeDir, config);
		removeCredentialKey(homeDir, username);
		console.log(`Removed ${username}.`);
	}
});

export default defineCommand({
	meta: { name: 'credential', description: 'Manage reusable Guardian/MCP credentials' },
	subCommands: { list, add, show, 'set-policy': setPolicy, rotate, remove }
});
