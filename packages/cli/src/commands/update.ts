import { defineCommand } from 'citty';
import {
	applyHomeSeed,
	acquireStackLock,
	activateComposeCommand,
	createOpenPalmState,
	ensureDockerReady,
	ensureRuntime,
	ensureStackConfig,
	releaseStackLock,
	requireInstall
} from '@openpalm/lib';

import { seedSkeletonFromEmbedded } from '../lib/embedded-assets.js';
export async function updateStack(options: { start: boolean; pull?: boolean }): Promise<void> {
	const state = createOpenPalmState();
	requireInstall(state.homeDir);
	if (options.start) {
		const docker = await ensureDockerReady();
		if (!docker.ok) throw new Error(docker.message);
	}

	const lock = acquireStackLock(state.dataDir);
	if (!lock) throw new Error('lifecycle_in_progress: Another stack operation is running.');
	try {
		await seedSkeletonFromEmbedded(applyHomeSeed, state.homeDir);
		ensureRuntime(state);
		ensureStackConfig(state.homeDir);
		if (options.start) {
			await activateComposeCommand(
				state,
				[
					'up',
					'-d',
					'--pull',
					options.pull === false ? 'never' : 'always',
					'--force-recreate',
					'--remove-orphans',
					'--wait'
				],
				{ lock }
			);
		}
	} finally {
		releaseStackLock(lock);
	}
	console.log(
		options.start
			? 'OpenPalm managed assets refreshed and containers recreated successfully.'
			: 'OpenPalm managed assets refreshed. Run `openpalm restart` to apply them.'
	);
}

export default defineCommand({
	meta: {
		name: 'update',
		description: 'Refresh an existing 0.14 stack without deleting user data'
	},
	args: {
		pull: {
			type: 'boolean',
			description:
				'Pull release images before recreating containers (use --no-pull for local builds)',
			default: true
		},
		start: {
			type: 'boolean',
			description: 'Apply the refreshed stack after writing it (use --no-start to skip)',
			default: true
		}
	},
	async run({ args }) {
		await updateStack({ start: args.start !== false, pull: args.pull !== false });
	}
});
