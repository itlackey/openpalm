import { defineCommand } from 'citty';
import { tryAdminRequest } from '../lib/admin.ts';
import { runDockerCompose } from '../lib/docker.ts';
import { ensureStagedState, fullComposeArgs } from '../lib/staging.ts';

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show container status',
  },
  async run() {
    // Try admin delegation first for richer output
    const adminResult = await tryAdminRequest('/admin/containers/list');
    if (adminResult !== null) {
      console.log(JSON.stringify(adminResult, null, 2));
      return;
    }

    // Direct compose ps
    const state = await ensureStagedState();
    await runDockerCompose([...fullComposeArgs(state), 'ps', '--format', 'table']);
  },
});
