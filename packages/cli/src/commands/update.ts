import { defineCommand } from 'citty';
import {
  PLATFORM_VERSION,
  performUpgrade,
  checkAndUpdateUiBuild,
  checkAndUpdateClientBuild,
} from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';
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
  const state = ensureValidState();

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

  // C3: `openpalm update` previously left the client artifact stale — it was
  // only ever refreshed lazily at `openpalm ui serve` time. Refresh it the
  // same way (and on the same reference version) as the UI build above.
  console.log('Checking for client app update...');
  const clientResult = await checkAndUpdateClientBuild(PLATFORM_VERSION, state.dataDir);
  if (clientResult.updated) {
    console.log(`Client app updated to v${clientResult.latestVersion}.`);
  } else if (clientResult.error) {
    console.warn(`Warning: client app update skipped — ${clientResult.error}. Existing build still active.`);
  } else {
    console.log(`Client app is current (v${clientResult.latestVersion}).`);
  }

  console.log('Update complete.');
}
