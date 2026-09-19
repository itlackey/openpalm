import { defineCommand } from 'citty';
import {
	createOpenPalmState,
	markInstalled,
	requireInstall,
	testAssistantReadiness,
	waitForAssistant
} from '@openpalm/lib';

import { defineAction } from '../lib/action.js';
import { runStartAction } from './lifecycle.js';
import { runNativeProviderLogin } from './provider.js';

export async function completeSetup(options: {
	provider?: string;
	method?: string;
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
		readiness = await testAssistantReadiness(state.homeDir);
	}

	if (!readiness.ok) throw new Error(`Provider readiness failed: ${readiness.error}`);
	markInstalled(state.homeDir);
	console.log('OpenPalm 0.14 setup is complete.');
	console.log(
		`Verified a real Assistant response${readiness.provider ? ` from ${readiness.provider}` : ''}${readiness.model ? `/${readiness.model}` : ''}.`
	);
}

export default defineCommand({
	meta: {
		name: 'setup',
		description: 'Start Assistant, sign in to a provider, and verify readiness'
	},
	args: {
		provider: { type: 'string', description: 'Provider id or name' },
		method: { type: 'string', description: 'OpenCode login method label' }
	},
	run: defineAction(async ({ args }) => {
		await completeSetup({
			provider: args.provider ? String(args.provider) : undefined,
			method: args.method ? String(args.method) : undefined
		});
	})
});
