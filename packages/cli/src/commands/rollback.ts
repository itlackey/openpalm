import { defineCommand } from 'citty';
import { runDockerCompose } from '../lib/docker.ts';
import { ensureValidState, fullComposeArgs, buildManagedServiceNames } from '../lib/staging.ts';
import {
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

    const state = await ensureValidState();
    restoreSnapshot(state);

    console.log('Snapshot restored. Restarting services...');

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
