import { defineCommand } from 'citty';
import { runDockerCompose } from '../lib/docker.ts';
import { ensureStagedState, fullComposeArgs, buildManagedServiceNames } from '../lib/staging.ts';

export default defineCommand({
  meta: {
    name: 'update',
    description: 'Pull latest images and recreate containers',
  },
  async run() {
    const state = await ensureStagedState();
    const composeArgs = fullComposeArgs(state);
    const managedServices = buildManagedServiceNames(state);

    console.log('Pulling latest images...');
    await runDockerCompose([...composeArgs, 'pull', ...managedServices]);

    console.log('Recreating containers...');
    await runDockerCompose([...composeArgs, 'up', '-d', '--force-recreate', ...managedServices]);

    console.log('Update complete.');
  },
});
