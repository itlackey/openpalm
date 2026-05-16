import { defineCommand } from 'citty';
import { rmSync } from 'node:fs';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeWithPreflight } from '../lib/cli-compose.ts';
import { resolveConfigDir, resolveStateDir, resolveServicesDir, resolveStashDir, resolveWorkspaceDir } from '@openpalm/lib';

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
    const state = ensureValidState();
    const downArgs = args.volumes || args.purge ? ['down', '-v'] : ['down'];
    await runComposeWithPreflight(state, downArgs);

    if (args.purge) {
      const dirs = [resolveConfigDir(), resolveStateDir(), resolveServicesDir(), resolveStashDir(), resolveWorkspaceDir()];
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
