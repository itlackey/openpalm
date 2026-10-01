import { defineCommand } from 'citty';
import {
	configureGuardianModeratorModel,
	createOpenPalmState,
	markInstalled,
	readStackConfig,
	requireInstall,
	testAssistantReadiness,
	waitForAssistant
} from '@openpalm/lib';

import { defineAction } from '../lib/action.js';
import { runRestartAction, runStartAction } from './lifecycle.js';
import { runNativeProviderLogin } from './provider.js';
import { enableRemote } from './remote.js';

export async function completeSetup(options: {
	provider?: string;
	method?: string;
	claudeRemote?: boolean;
	codexRemote?: boolean;
}): Promise<void> {
	const state = createOpenPalmState();
	requireInstall(state.homeDir);
	await runStartAction();
	await waitForAssistant(state.homeDir);

	let readiness = await testAssistantReadiness(state.homeDir);
	if (!readiness.ok) {
		const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
		if (!interactive && !options.provider) {
			throw new Error(
				`Provider sign-in is required (${readiness.error}). Run \`openpalm provider login <provider>\` in a terminal, or use \`openpalm provider key <provider> --key-file <path>\`.`
			);
		}
		console.log(`Provider readiness needs attention: ${readiness.error}`);
		await runNativeProviderLogin(options);
		readiness = await testAssistantReadiness(
			state.homeDir,
			options.provider ? { provider: options.provider } : {}
		);
	}

	if (!readiness.ok) throw new Error(`Provider readiness failed: ${readiness.error}`);
	const moderatorUpdated = configureGuardianModeratorModel(
		state.homeDir,
		readiness.provider,
		readiness.model
	);
	markInstalled(state.homeDir);
	const config = readStackConfig(state.homeDir);
	if (!config.ok) throw new Error(config.error);
	if (moderatorUpdated && config.config.gateway.enabled) await runRestartAction();
	console.log('OpenPalm 0.14 setup is complete.');
	console.log(
		`Verified a real Assistant response${readiness.provider ? ` from ${readiness.provider}` : ''}${readiness.model ? `/${readiness.model}` : ''}.`
	);
	if (options.claudeRemote) await enableRemote('claude');
	if (options.codexRemote) await enableRemote('codex');
}

export default defineCommand({
	meta: {
		name: 'setup',
		description: 'Start Assistant, sign in to a provider, and verify readiness'
	},
	args: {
		provider: { type: 'string', description: 'Provider id or name' },
		method: { type: 'string', description: 'OpenCode login method label' },
		'claude-remote': {
			type: 'boolean',
			description: 'Guide Claude Remote Control sign-in after provider setup'
		},
		'codex-remote': {
			type: 'boolean',
			description: 'Guide Codex remote sign-in after provider setup'
		}
	},
	run: defineAction(async ({ args }) => {
		await completeSetup({
			provider: args.provider ? String(args.provider) : undefined,
			method: args.method ? String(args.method) : undefined,
			claudeRemote: args['claude-remote'] === true,
			codexRemote: args['codex-remote'] === true
		});
	})
});
