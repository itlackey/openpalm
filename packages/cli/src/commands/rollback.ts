import { defineCommand } from 'citty';
import { runDockerCompose } from '../lib/docker.ts';
import { ensureValidState, fullComposeArgs, buildManagedServiceNames } from '../lib/staging.ts';
import {
  createState,
  restoreSnapshot,
  hasSnapshot,
  snapshotTimestamp,
} from '@openpalm/lib';

export default defineCommand({
  meta: {
    name: 'rollback',
    description: 'Restore the most recent configuration snapshot and restart services',
  },
  async run() {
    if (!hasSnapshot()) {
      console.error('No rollback snapshot available.');
      process.exit(1);
    }

    const ts = snapshotTimestamp();
    console.log(`Restoring snapshot from ${ts ?? 'unknown'}...`);

    // Create state without persisting so we don't overwrite live config
    // before the snapshot is restored.
    const rollbackState = createState();
    restoreSnapshot(rollbackState);

    console.log('Snapshot restored. Rebuilding configuration...');

    // Now validate and persist with the restored files in place
    const state = await ensureValidState();

    const composeArgs = fullComposeArgs(state);
    const managedServices = buildManagedServiceNames(state);

    await runDockerCompose([
      ...composeArgs,
      'up',
      '-d',
      '--remove-orphans',
      ...managedServices,
    ]);

    console.log('Rollback complete.');
  },
});
