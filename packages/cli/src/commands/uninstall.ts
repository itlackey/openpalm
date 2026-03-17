import { defineCommand } from 'citty';
import { tryAdminRequest } from '../lib/admin.ts';
import { runDockerCompose } from '../lib/docker.ts';
import { ensureStagedState, fullComposeArgs } from '../lib/staging.ts';

export default defineCommand({
  meta: {
    name: 'uninstall',
    description: 'Stop and remove the OpenPalm stack (preserves config and data)',
  },
  args: {
    volumes: {
      type: 'boolean',
      description: 'Also remove Docker volumes',
      default: false,
    },
  },
  async run({ args }) {
    // Try admin delegation first
    const adminResult = await tryAdminRequest('/admin/uninstall', { method: 'POST' });
    if (adminResult !== null) {
      console.log(JSON.stringify(adminResult, null, 2));
      return;
    }

    // Direct compose down
    const state = await ensureStagedState();
    const composeArgs = fullComposeArgs(state);
    const downArgs = args.volumes ? ['down', '-v'] : ['down'];
    await runDockerCompose([...composeArgs, ...downArgs]);

    console.log('OpenPalm stack stopped and removed.');
    if (!args.volumes) {
      console.log('Config and data directories are preserved. Use --volumes to also remove Docker volumes.');
    }
  },
});
