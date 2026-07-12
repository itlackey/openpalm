import { defineCommand } from 'citty';
import { performUpgrade, checkAndUpdateUiBuild, checkAndUpdateClientBuild } from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';
import { defineAction } from '../lib/action.ts';

export default defineCommand({
  meta: {
    name: 'update',
    description: 'Refresh stack assets, pull latest images, and recreate containers',
  },
  args: {
    pre: {
      type: 'boolean',
      description: 'Opt in to prerelease (rc/beta) versions. By default a stable install stays on stable.',
      default: false,
    },
  },
  run: defineAction(
    async ({ args }) => {
      await runUpgradeAction({ allowPrerelease: !!args.pre });
    },
    (message) => {
      console.error(message);
      console.error('If something went wrong, your previous state was backed up before this update — run `openpalm rollback` to restore it.');
    },
  ),
});

export async function runUpgradeAction(opts: { allowPrerelease?: boolean } = {}): Promise<void> {
  const state = ensureValidState();

  console.log(`Upgrading stack${opts.allowPrerelease ? ' (including prereleases)' : ''}...`);
  const result = await performUpgrade(state, { allowPrerelease: opts.allowPrerelease });
  console.log(`Image tag: ${result.namespace}/*:${result.imageTag}`);
  if (result.assetsUpdated.length > 0) {
    console.log(`Assets updated: ${result.assetsUpdated.join(', ')}`);
  }
  for (const w of result.warnings) {
    console.warn(`Warning: ${w}`);
  }

  // Check for a newer UI build on GitHub and install it if available.
  // Passes the pre-upgrade image tag as the reference version so any newer
  // release (including the one just upgraded to) triggers a download.
  // Existing data/ui/ is backed up to data/backups/ui-{timestamp}/ before
  // replacement. Non-fatal — existing build remains on any error.
  const currentVersion = result.imageTag;
  console.log('Checking for UI build update...');
  const uiResult = await checkAndUpdateUiBuild(currentVersion, state.dataDir);
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
  const clientResult = await checkAndUpdateClientBuild(currentVersion, state.dataDir);
  if (clientResult.updated) {
    console.log(`Client app updated to v${clientResult.latestVersion}.`);
  } else if (clientResult.error) {
    console.warn(`Warning: client app update skipped — ${clientResult.error}. Existing build still active.`);
  } else {
    console.log(`Client app is current (v${clientResult.latestVersion}).`);
  }

  console.log('Update complete.');
}
