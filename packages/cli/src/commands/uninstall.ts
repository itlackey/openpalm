import { defineCommand } from 'citty';
import { rmSync } from 'node:fs';
import { runDockerCompose } from '../lib/docker.ts';
import { ensureStagedState, fullComposeArgs } from '../lib/staging.ts';
import { resolveConfigHome, resolveDataHome, resolveStateHome } from '@openpalm/lib';

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
    purge: {
      type: 'boolean',
      description: 'Remove all OpenPalm XDG directories (config, data, state)',
      default: false,
    },
  },
  async run({ args }) {
    // Include admin profile to tear down all services
    const state = await ensureStagedState();
    const composeArgs = fullComposeArgs(state);
    const downArgs = args.volumes || args.purge ? ['down', '-v'] : ['down'];
    await runDockerCompose([...composeArgs, '--profile', 'admin', ...downArgs]);

    if (args.purge) {
      const dirs = [resolveConfigHome(), resolveDataHome(), resolveStateHome()];
      for (const dir of dirs) {
        console.log(`Removing ${dir}`);
        rmSync(dir, { recursive: true, force: true });
      }
      console.log('OpenPalm stack and all data removed.');
    } else {
      console.log('OpenPalm stack stopped and removed.');
      if (!args.volumes) {
        console.log('Config and data directories are preserved. Use --purge to remove everything.');
      }
    }
  },
});
