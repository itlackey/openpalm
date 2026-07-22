import { defineCommand } from 'citty';
import { join } from 'node:path';
import {
  PLATFORM_VERSION,
  performUpgrade,
  checkAndUpdateUiBuild,
  classifyLocalInstall,
  createState,
  type ControlPlaneState,
} from '@openpalm/lib';
import { defineAction } from '../lib/action.ts';

export default defineCommand({
  meta: {
    name: 'update',
    description: 'Refresh stack assets and safely reapply running containers',
  },
  run: defineAction(
    async () => {
      await runUpgradeAction();
    },
    (message) => {
      console.error(message);
      console.error('If something went wrong, your previous state was backed up before this update — run `openpalm rollback` to restore it.');
    },
  ),
});

export async function runUpgradeAction(): Promise<void> {
  const state = resolveUpgradeState();

  console.log('Updating stack...');
  await performUpgrade(state);

  // Check for a newer UI build on GitHub and install it if available.
  // Pass the running control-plane version as the reference so any newer
  // release (including the one just upgraded to) triggers a download.
  // Existing data/ui/ is backed up to data/backups/ui-{timestamp}/ before
  // replacement. Non-fatal — existing build remains on any error.
  console.log('Checking for UI build update...');
  const uiResult = await checkAndUpdateUiBuild(PLATFORM_VERSION, state.dataDir);
  if (uiResult.updated) {
    console.log(`UI build updated to v${uiResult.latestVersion}.`);
  } else if (uiResult.error) {
    console.warn(`Warning: UI build update skipped — ${uiResult.error}. Existing build still active.`);
  } else {
    console.log(`UI build is current (v${uiResult.latestVersion}).`);
  }

  console.log('Update complete.');
}

export function resolveUpgradeState(): ControlPlaneState {
  const state = createState();
  const currentInstall = classifyLocalInstall(state.stackDir, state.homeDir);
  const legacyStackDir = join(state.homeDir, 'config', 'stack');
  const legacyInstall = classifyLocalInstall(legacyStackDir, state.homeDir);
  if (currentInstall === 'not_installed' && legacyInstall === 'not_installed') {
    throw new Error('OpenPalm is not installed in this OP_HOME yet. Run `openpalm install` first.');
  }
  return state;
}
