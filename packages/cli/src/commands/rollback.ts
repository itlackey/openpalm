import { defineCommand } from 'citty';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeWithPreflight } from '../lib/cli-compose.ts';
import { promptYesNo } from '../lib/prompt.ts';
import { defineAction } from '../lib/action.ts';
import {
	buildManagedServices,
	createState,
	restoreSnapshot,
	hasSnapshot,
	snapshotTimestamp,
	acquireInstallLock,
	releaseInstallLock,
	currentSnapshotGeneration,
	snapshotCurrentState
} from '@openpalm/lib';

export default defineCommand({
	meta: {
		name: 'rollback',
		description: 'Restore the most recent configuration snapshot and restart services'
	},
	args: {
		yes: {
			type: 'boolean',
			alias: 'y',
			description: 'Skip the confirmation prompt',
			default: false
		}
	},
	run: defineAction(async ({ args }) => {
		await runRollbackAction({ yes: !!args.yes });
	})
});

export async function runRollbackAction(opts: { yes?: boolean } = {}): Promise<void> {
	if (!hasSnapshot()) {
		throw new Error('No rollback snapshot available.');
	}

	const ts = snapshotTimestamp();
	console.log(`Rollback will overwrite live config with the snapshot from ${ts ?? 'unknown'}.`);
	console.log(
		'The files it overwrites are backed up first under data/backups/<timestamp>-pre-rollback/.'
	);

	if (!opts.yes) {
		const ok = await promptYesNo('Restore this snapshot? [y/N]');
		if (!ok) {
			console.log('Rollback aborted. Re-run with --yes to skip confirmation.');
			return;
		}
	}

	console.log(`Restoring snapshot from ${ts ?? 'unknown'}...`);

	// Create state without persisting so we don't overwrite live config
	// before the snapshot is restored.
	const rollbackState = createState();

	// Hold the install lock across the snapshot restore AND the compose recreate
	// so a concurrent install/update can't race the config swap or the restart.
	const lock = acquireInstallLock(rollbackState.dataDir);
	if (!lock) {
		throw new Error(
			"install_in_progress: Another install or update is already running. Wait for it to finish, or run 'openpalm unlock' to clear a stale lock."
		);
	}
	try {
		const targetGeneration = currentSnapshotGeneration() ?? undefined;
		let preRollbackGeneration: string | undefined;
		try {
			preRollbackGeneration = snapshotCurrentState(rollbackState);
		} catch {
			/* test seams and empty homes have no pre-image */
		}
		restoreSnapshot(rollbackState, targetGeneration);

		console.log('Snapshot restored. Rebuilding configuration...');

		// Now validate and persist with the restored files in place
		const state = ensureValidState();

		const managedServices = await buildManagedServices(state);

		try {
			await runComposeWithPreflight(
				state,
				['up', '-d', '--wait', '--remove-orphans', ...managedServices],
				lock
			);
		} catch (error) {
			// Manual rollback is transactional too: if the restored generation does
			// not pass the same apply/health gate, put the pre-rollback generation
			// back and attempt to return the previously running stack.
			if (preRollbackGeneration) {
				restoreSnapshot(rollbackState, preRollbackGeneration);
				const restoredState = ensureValidState();
				await runComposeWithPreflight(
					restoredState,
					['up', '-d', '--wait', '--remove-orphans', ...managedServices],
					lock
				);
			}
			throw error;
		}
	} finally {
		releaseInstallLock(lock);
	}

	console.log('Rollback complete.');
}
