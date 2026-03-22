import { defineCommand } from 'citty';
import { ensureValidState } from '../lib/cli-state.ts';
import { buildManagedServiceNames, runComposeWithPreflight } from '../lib/cli-compose.ts';

export default defineCommand({
  meta: {
    name: 'update',
    description: 'Pull latest images and recreate containers',
  },
  async run() {
    const state = await ensureValidState();
    const managedServices = await buildManagedServiceNames(state);

    console.log('Pulling latest images...');
    await runComposeWithPreflight(state, ['pull', ...managedServices]);

    console.log('Recreating containers...');
    await runComposeWithPreflight(state, ['up', '-d', '--force-recreate', ...managedServices]);

    console.log('Update complete.');
  },
});
