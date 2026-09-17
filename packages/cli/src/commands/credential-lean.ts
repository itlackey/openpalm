import { defineCommand } from 'citty';
import { readFileSync } from 'node:fs';

import {
	createCredentialId,
	ensureCredentialKeys,
	generateCredentialKey,
	isCredentialUsername,
	isGuardianPolicy,
	isPortalName,
	isPortalUserId,
	normalizeCredentialKey,
	portalCredentialUsages,
	readCredentialKey,
	readPortalCredentialMap,
	readStackConfig,
	removeCredentialKey,
	requireLeanInstall,
	resolveOpenPalmHome,
	syncPortalCredentialBundles,
	writeCredentialKey,
	writePortalCredentialMap,
	writeStackConfig,
	type GuardianPolicy,
	type PortalName,
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

function requirePortal(value: string): PortalName {
	if (!isPortalName(value)) throw new Error('Portal must be discord or slack.');
	return value;
}

function requirePortalUserId(portal: PortalName, value: string): string {
	if (!isPortalUserId(portal, value)) {
		throw new Error(
			portal === 'discord'
				? 'Discord user ID must be a numeric snowflake.'
				: 'Slack user ID must be an uppercase platform ID such as U012ABCDEF.'
		);
	}
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
		const { homeDir, config } = current();
		for (const [username, credential] of Object.entries(config.credentials).sort(([a], [b]) =>
			a.localeCompare(b)
		)) {
			const usages = portalCredentialUsages(homeDir, config, username);
			console.log(
				`${username}\t${credential.policy}${usages.length ? `\tassigned=${usages.join(',')}` : ''}`
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
		syncPortalCredentialBundles(homeDir, config);
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
		const usages = portalCredentialUsages(homeDir, config, username);
		if (usages.length > 0) {
			throw new Error(
				`Credential ${username} is assigned to ${usages.join(', ')}. Reassign or unmap it before removing it.`
			);
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

const map = defineCommand({
	meta: { name: 'map', description: 'Map a Slack or Discord user to a named credential' },
	args: {
		portal: { type: 'positional', required: true, description: 'discord or slack' },
		userId: { type: 'positional', required: true, description: 'platform user ID' },
		username: { type: 'positional', required: true, description: 'credential username' }
	},
	run({ args }) {
		const portal = requirePortal(positional(args, 0));
		const userId = requirePortalUserId(portal, positional(args, 1));
		const username = requireUsername(positional(args, 2));
		const { homeDir, config } = current();
		if (!Object.hasOwn(config.credentials, username)) {
			throw new Error(`Unknown credential: ${username}. Create it first.`);
		}
		const mapping = readPortalCredentialMap(homeDir, portal);
		mapping.users[userId] = username;
		writePortalCredentialMap(homeDir, portal, mapping);
		syncPortalCredentialBundles(homeDir, config);
		console.log(`${portal} user ${userId}: ${username} (${config.credentials[username]?.policy})`);
	}
});

const unmap = defineCommand({
	meta: { name: 'unmap', description: 'Remove a Slack or Discord user credential override' },
	args: {
		portal: { type: 'positional', required: true, description: 'discord or slack' },
		userId: { type: 'positional', required: true, description: 'platform user ID' }
	},
	run({ args }) {
		const portal = requirePortal(positional(args, 0));
		const userId = requirePortalUserId(portal, positional(args, 1));
		const { homeDir, config } = current();
		const mapping = readPortalCredentialMap(homeDir, portal);
		if (!Object.hasOwn(mapping.users, userId)) {
			throw new Error(`${portal} user ${userId} has no credential mapping.`);
		}
		delete mapping.users[userId];
		writePortalCredentialMap(homeDir, portal, mapping);
		syncPortalCredentialBundles(homeDir, config);
		console.log(`${portal} user ${userId} now uses the portal default credential.`);
	}
});

const mappings = defineCommand({
	meta: { name: 'mappings', description: 'List a portal default and per-user credential mappings' },
	args: { portal: { type: 'positional', required: true, description: 'discord or slack' } },
	run({ args }) {
		const portal = requirePortal(positional(args, 0));
		const { homeDir, config } = current();
		const mapping = readPortalCredentialMap(homeDir, portal);
		const defaultUsername = config.portals[portal].credential;
		console.log(`default\t${defaultUsername}\t${config.credentials[defaultUsername]?.policy}`);
		for (const [userId, username] of Object.entries(mapping.users)) {
			console.log(`${userId}\t${username}\t${config.credentials[username]?.policy}`);
		}
	}
});

export default defineCommand({
	meta: { name: 'credential', description: 'Manage reusable Guardian/MCP credentials' },
	subCommands: { list, add, show, 'set-policy': setPolicy, rotate, remove, map, unmap, mappings }
});
