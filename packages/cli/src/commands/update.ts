import { defineCommand } from 'citty';
import {
	applyHomeSeed,
	createOpenPalmState,
	ensureDockerReady,
	ensureRuntime,
	ensureStackConfig,
	requireInstall
} from '@openpalm/lib';

import { seedSkeletonFromEmbedded } from '../lib/embedded-assets.js';
import { runStartAction } from './lifecycle.js';

export async function updateStack(options: { start: boolean }): Promise<void> {
	const state = createOpenPalmState();
	requireInstall(state.homeDir);
	if (options.start) {
		const docker = await ensureDockerReady();
		if (!docker.ok) throw new Error(docker.message);
	}

	await seedSkeletonFromEmbedded(applyHomeSeed, state.homeDir);
	ensureRuntime(state);
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
		await updateStack({ start: args.start !== false });
	}
});
