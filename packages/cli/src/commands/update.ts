import { defineCommand } from 'citty';
import { updateStackEnvToLatestImageTag } from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';
import { buildManagedServiceNames, runComposeWithPreflight } from '../lib/cli-compose.ts';

export default defineCommand({
  meta: {
    name: 'update',
    description: 'Pull latest images and recreate containers',
  },
  async run() {
    const state = await ensureValidState();

    console.log('Checking for latest image tag...');
    const { namespace, tag } = await updateStackEnvToLatestImageTag(state);
    console.log(`Using ${namespace}/*:${tag}`);

    const managedServices = await buildManagedServiceNames(state);

    console.log('Pulling images...');
    await runComposeWithPreflight(state, ['pull', ...managedServices]);

    console.log('Recreating containers...');
    await runComposeWithPreflight(state, ['up', '-d', '--force-recreate', ...managedServices]);

    console.log('Update complete.');
  },
});
