import { defineCommand } from 'citty';
import {
	applyLeanHomeSeed,
	createLeanState,
	ensureDockerReady,
	ensureLeanRuntime,
	ensureStackConfig,
	requireLeanInstall
} from '@openpalm/lib/lean';

import { seedLeanSkeletonFromEmbedded } from '../lib/embedded-lean-assets.js';
import { runStartAction } from './lifecycle-lean.js';

export async function updateLeanStack(options: { start: boolean }): Promise<void> {
	const state = createLeanState();
	requireLeanInstall(state.homeDir);
	if (options.start) {
		const docker = await ensureDockerReady();
		if (!docker.ok) throw new Error(docker.message);
	}

	await seedLeanSkeletonFromEmbedded(applyLeanHomeSeed, state.homeDir);
	ensureLeanRuntime(state);
	ensureStackConfig(state.homeDir);

	if (options.start) await runStartAction();
	console.log('OpenPalm 0.14 stack assets and configuration are current.');
}

export default defineCommand({
	meta: {
		name: 'update',
		description: 'Refresh an existing 0.14 stack without deleting user data'
	},
	args: {
		start: {
			type: 'boolean',
			description: 'Apply the refreshed stack after writing it (use --no-start to skip)',
			default: true
		}
	},
	async run({ args }) {
		await updateLeanStack({ start: args.start !== false });
	}
});
