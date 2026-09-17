import { defineCommand } from 'citty';
import {
	applyLeanHomeSeed,
	createLeanState,
	ensureDockerReady,
	ensureLeanRuntime,
	ensureStackConfig,
	markLeanInstalled,
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
	markLeanInstalled(state.homeDir);

	if (options.start) await runStartAction();
	console.log('OpenPalm lean stack assets and configuration are current.');
	console.log(
		'Legacy files and data were preserved; see the migration report before removing them.'
	);
}

export default defineCommand({
	meta: {
		name: 'update',
		description: 'Migrate or refresh the lean stack without deleting legacy data'
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
