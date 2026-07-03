import { defineCommand } from 'citty';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeWithPreflight } from '../lib/cli-compose.ts';
import { defineAction } from '../lib/action.ts';
import {
  buildManagedServices,
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
  run: defineAction(async () => {
    if (!hasSnapshot()) {
      throw new Error('No rollback snapshot available.');
    }

    const ts = snapshotTimestamp();
    console.log(`Restoring snapshot from ${ts ?? 'unknown'}...`);

    // Create state without persisting so we don't overwrite live config
    // before the snapshot is restored.
    const rollbackState = createState();
    restoreSnapshot(rollbackState);

    console.log('Snapshot restored. Rebuilding configuration...');

    // Now validate and persist with the restored files in place
    const state = ensureValidState();

    const managedServices = await buildManagedServices(state);

    await runComposeWithPreflight(state, [
      'up', '-d', '--remove-orphans', ...managedServices,
    ]);

    console.log('Rollback complete.');
  }),
});
