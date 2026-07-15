import { defineCommand } from 'citty';
import { rmSync } from 'node:fs';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeWithPreflight } from '../lib/cli-compose.ts';
import {
  acquireInstallLock,
  releaseInstallLock,
  resolveConfigDir,
  resolveDataDir,
  resolveStashDir,
  resolveWorkspaceDir,
} from '@openpalm/lib';
import { defineAction } from '../lib/action.ts';

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
      description: 'Remove all OpenPalm directories (config, data, knowledge, workspace)',
      default: false,
    },
  },
  run: defineAction(async ({ args }) => {
    const state = ensureValidState();
    const lock = acquireInstallLock(state.dataDir);
    if (!lock) throw new Error('install_in_progress: Another lifecycle operation is already running.');
    let purgeRemovedLock = false;
    try {
    const downArgs = args.volumes || args.purge ? ['down', '-v'] : ['down'];
    await runComposeWithPreflight(state, downArgs);

    if (args.purge) {
      // dataDir owns the lifecycle lock, so remove it only after every other
      // destructive purge step has completed.
      const dirs = [resolveConfigDir(), resolveStashDir(), resolveWorkspaceDir(), resolveDataDir()];
      for (const dir of dirs) {
        console.log(`Removing ${dir}`);
        rmSync(dir, { recursive: true, force: true });
        if (dir === state.dataDir) purgeRemovedLock = true;
      }
      console.log('OpenPalm stack and all data removed.');
    } else {
      console.log('OpenPalm stack stopped and removed.');
      if (!args.volumes) {
        console.log('Config and data directories are preserved. Use --purge to remove everything.');
      }
    }
    } finally {
      if (!purgeRemovedLock) releaseInstallLock(lock);
    }
  }),
});
