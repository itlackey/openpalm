import { defineCommand } from 'citty';

import {
	readStackConfig,
	requireInstall,
	resolveOpenPalmHome,
	writeStackConfig,
	type StackConfig
} from '@openpalm/lib';

import { runStartAction } from './lifecycle.js';

const ADDONS = ['gateway', 'discord', 'slack'] as const;
type Addon = (typeof ADDONS)[number];

function readConfig(): { homeDir: string; config: StackConfig } {
	const homeDir = resolveOpenPalmHome();
	requireInstall(homeDir);
	const result = readStackConfig(homeDir);
	if (!result.ok) throw new Error(result.error);
	return { homeDir, config: result.config };
}

function isAddon(value: string): value is Addon {
	return ADDONS.includes(value as Addon);
}

function setIntent(config: StackConfig, addon: Addon, enabled: boolean): void {
	if (
		addon === 'gateway' &&
		!enabled &&
		(config.portals.discord.enabled || config.portals.slack.enabled)
	) {
		throw new Error('Disable the Discord and Slack portals before disabling their gateway.');
	}
	if (addon === 'gateway') config.gateway.enabled = enabled;
	else config.portals[addon].enabled = enabled;
	if (config.portals.discord.enabled || config.portals.slack.enabled) config.gateway.enabled = true;
}

export async function setAddon(
	addon: Addon,
	enabled: boolean,
	apply = true
): Promise<void> {
	const { homeDir, config } = readConfig();
	setIntent(config, addon, enabled);
	writeStackConfig(homeDir, config);
	console.log(`${enabled ? 'Enabled' : 'Disabled'} ${addon}.`);
	if (apply) await runStartAction();
}

const list = defineCommand({
	meta: { name: 'list', description: 'List the three optional components' },
	async run() {
		const { config } = readConfig();
		console.log(`${config.gateway.enabled ? '[enabled]' : '[disabled]'} gateway`);
		console.log(`${config.portals.discord.enabled ? '[enabled]' : '[disabled]'} discord`);
		console.log(`${config.portals.slack.enabled ? '[enabled]' : '[disabled]'} slack`);
	}
});

function mutationCommand(enabled: boolean) {
	return defineCommand({
		meta: {
			name: enabled ? 'enable' : 'disable',
			description: `${enabled ? 'Enable' : 'Disable'} gateway, discord, or slack`
		},
		args: {
			name: { type: 'positional', required: true, description: 'gateway, discord, or slack' },
			apply: {
				type: 'boolean',
				description: 'Apply the changed stack immediately (use --no-apply to defer)',
				default: true
			}
		},
		async run({ args }) {
			const name = String(args._?.[0] ?? '');
			if (!isAddon(name)) throw new Error(`Unknown addon "${name}". Choose: ${ADDONS.join(', ')}`);
			await setAddon(name, enabled, args.apply !== false);
		}
	});
}

export default defineCommand({
	meta: { name: 'addon', description: 'Manage gateway, Discord, and Slack profiles' },
	subCommands: {
		list,
		enable: mutationCommand(true),
		disable: mutationCommand(false)
	}
});
