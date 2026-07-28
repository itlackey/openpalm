import { defineCommand } from 'citty';
import {
	buildManagedServices,
	teardownRenamedProject,
	acquireInstallLock,
	releaseInstallLock
} from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeWithPreflight } from '../lib/cli-compose.ts';
import { defineAction } from '../lib/action.ts';

export default defineCommand({
	meta: {
		name: 'restart',
		description: 'Restart services (all or named)'
	},
	args: {
		services: {
			type: 'positional',
			description: 'Service names to restart (omit for all)',
			required: false
		}
	},
	run: defineAction(async ({ args }) => {
		const services = args._ ?? [];
		await runRestartAction(services);
	})
});

export async function runRestartAction(services: string[]): Promise<void> {
	if (services.length === 0) {
		// Restart all managed services (admin included if enabled)
		const state = ensureValidState();
		const lock = acquireInstallLock(state.dataDir);
		if (!lock)
			throw new Error('install_in_progress: Another install or update is already running.');
		try {
			const managedServices = await buildManagedServices(state);

			// Project rename (#540): after OP_PROJECT_NAME changes, no containers
			// exist under the new name yet — a plain `restart` would no-op while the
			// old project keeps running. Stop the recorded outgoing project, then
			// `up -d` so the stack is (re)created under the new name. A blocked
			// teardown aborts instead of reporting a restart that never migrated.
			const renameTeardown = await teardownRenamedProject(state);
			if (renameTeardown.blocked) {
				throw new Error(renameTeardown.warning ?? 'Project rename teardown failed.');
			}
			if (renameTeardown.warning) console.warn(renameTeardown.warning);
			if (renameTeardown.downed) {
				console.log(`Project rename: stopped previous docker project "${renameTeardown.downed}".`);
				await runComposeWithPreflight(state, ['up', '-d', ...managedServices], lock);
				return;
			}

			await runComposeWithPreflight(state, ['restart', ...managedServices], lock);
		} finally {
			releaseInstallLock(lock);
		}
		return;
	}

	const state = ensureValidState();
	const lock = acquireInstallLock(state.dataDir);
	if (!lock) throw new Error('install_in_progress: Another install or update is already running.');
	try {
		for (const service of services)
			await runComposeWithPreflight(state, ['restart', service], lock);
	} finally {
		releaseInstallLock(lock);
	}
}
