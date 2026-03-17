import { defineCommand } from 'citty';
import { tryAdminRequest } from '../lib/admin.ts';
import { runDockerCompose } from '../lib/docker.ts';
import { ensureStagedState, fullComposeArgs, buildManagedServiceNames } from '../lib/staging.ts';

export default defineCommand({
  meta: {
    name: 'update',
    description: 'Pull latest images and recreate containers',
  },
  async run() {
    // Try admin delegation first
    const adminResult = await tryAdminRequest('/admin/containers/pull', { method: 'POST' });
    if (adminResult !== null) {
      console.log(JSON.stringify(adminResult, null, 2));
      return;
    }

    // Direct compose: pull + recreate
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
