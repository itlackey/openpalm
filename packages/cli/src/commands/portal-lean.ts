import { defineCommand } from 'citty';
import { readFileSync } from 'node:fs';

import {
	isPortalName,
	portalSecretConfigured,
	readStackConfig,
	requireLeanInstall,
	resolveOpenPalmHome,
	writePortalSecret,
	writeStackConfig,
	type PortalName,
	type PortalSecretName,
	type StackConfig
} from '@openpalm/lib/lean';

import { runRestartAction } from './lifecycle-lean.js';

function positional(args: { _?: unknown[] }): PortalName {
	const portal = String(args._?.[0] ?? '');
	if (!isPortalName(portal)) throw new Error('Portal must be discord or slack.');
	return portal;
}

function current(): { homeDir: string; config: StackConfig } {
	const homeDir = resolveOpenPalmHome();
	requireLeanInstall(homeDir);
	const result = readStackConfig(homeDir);
	if (!result.ok) throw new Error(result.error);
	return { homeDir, config: result.config };
}

function ids(value: unknown): string[] {
	return String(value ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

function secret(path: string): string {
	return path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
}

const show = defineCommand({
	meta: { name: 'show', description: 'Show access scope and token status without secret values' },
	args: { portal: { type: 'positional', required: true } },
	run({ args }) {
		const portal = positional(args);
		const { homeDir, config } = current();
		console.log(
			JSON.stringify(
				{
					...config.portals[portal],
					secrets: portalSecretConfigured(homeDir, portal)
				},
				null,
				2
			)
		);
	}
});

const access = defineCommand({
	meta: { name: 'access', description: 'Set a default-deny Discord or Slack allowlist' },
	args: {
		portal: { type: 'positional', required: true },
		guilds: { type: 'string', description: 'comma-separated Discord guild IDs' },
		roles: { type: 'string', description: 'comma-separated Discord role IDs' },
		channels: { type: 'string', description: 'comma-separated Slack channel IDs' },
		users: { type: 'string', description: 'comma-separated allowed user IDs' },
		blockedUsers: { type: 'string', description: 'comma-separated blocked user IDs' },
		clear: { type: 'boolean', description: 'clear every allowlist entry' },
		apply: {
			type: 'boolean',
			description: 'restart enabled services immediately (use --no-apply to defer)',
			default: true
		}
	},
	async run({ args }) {
		const portal = positional(args);
		const { homeDir, config } = current();
		const supplied = [args.guilds, args.roles, args.channels, args.users, args.blockedUsers].some(
			(value) => value !== undefined
		);
		if (!args.clear && !supplied) {
			console.log(JSON.stringify(config.portals[portal].access, null, 2));
			return;
		}
		if (portal === 'discord') {
			if (args.channels !== undefined) throw new Error('--channels is valid only for Slack.');
			if (args.clear)
				config.portals.discord.access = { guilds: [], roles: [], users: [], blockedUsers: [] };
			if (args.guilds !== undefined) config.portals.discord.access.guilds = ids(args.guilds);
			if (args.roles !== undefined) config.portals.discord.access.roles = ids(args.roles);
			if (args.users !== undefined) config.portals.discord.access.users = ids(args.users);
			if (args.blockedUsers !== undefined) {
				config.portals.discord.access.blockedUsers = ids(args.blockedUsers);
			}
		} else {
			if (args.guilds !== undefined || args.roles !== undefined) {
				throw new Error('--guilds and --roles are valid only for Discord.');
			}
			if (args.clear) config.portals.slack.access = { channels: [], users: [], blockedUsers: [] };
			if (args.channels !== undefined) config.portals.slack.access.channels = ids(args.channels);
			if (args.users !== undefined) config.portals.slack.access.users = ids(args.users);
			if (args.blockedUsers !== undefined) {
				config.portals.slack.access.blockedUsers = ids(args.blockedUsers);
			}
		}
		writeStackConfig(homeDir, config);
		console.log(JSON.stringify(config.portals[portal].access, null, 2));
		if (args.apply !== false && config.portals[portal].enabled) await runRestartAction();
	}
});

const token = defineCommand({
	meta: {
		name: 'token',
		description: 'Store portal tokens from files or stdin without printing them'
	},
	args: {
		portal: { type: 'positional', required: true },
		botTokenFile: { type: 'string', description: 'bot token file; use - for stdin' },
		appTokenFile: { type: 'string', description: 'Slack app token file; use - for stdin' },
		apply: {
			type: 'boolean',
			description: 'restart enabled services immediately (use --no-apply to defer)',
			default: true
		}
	},
	async run({ args }) {
		const portal = positional(args);
		if (!args.botTokenFile && !args.appTokenFile) {
			throw new Error('Pass --bot-token-file and, for Slack, optionally --app-token-file.');
		}
		if (portal === 'discord' && args.appTokenFile) {
			throw new Error('--app-token-file is valid only for Slack.');
		}
		const { homeDir, config } = current();
		const written: string[] = [];
		if (args.botTokenFile) {
			const name: PortalSecretName = portal === 'discord' ? 'discord_bot_token' : 'slack_bot_token';
			written.push(writePortalSecret(homeDir, portal, name, secret(String(args.botTokenFile))));
		}
		if (args.appTokenFile) {
			written.push(
				writePortalSecret(homeDir, portal, 'slack_app_token', secret(String(args.appTokenFile)))
			);
		}
		for (const path of written) console.log(`Stored secret: ${path}`);
		if (args.apply !== false && config.portals[portal].enabled) await runRestartAction();
	}
});

export default defineCommand({
	meta: { name: 'portal', description: 'Configure Slack and Discord access safely' },
	subCommands: { show, access, token }
});
