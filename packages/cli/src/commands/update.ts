import { defineCommand } from 'citty';
import { performUpgrade } from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';
import { seedUiBuild } from '../lib/io.ts';

export default defineCommand({
  meta: {
    name: 'update',
    description: 'Refresh stack assets, pull latest images, and recreate containers',
  },
  async run() {
    await runUpgradeAction();
  },
});

export async function runUpgradeAction(): Promise<void> {
  const state = ensureValidState();

  console.log('Upgrading stack...');
  const result = await performUpgrade(state);
  console.log(`Image tag: ${result.namespace}/*:${result.imageTag}`);
  if (result.assetsUpdated.length > 0) {
    console.log(`Assets updated: ${result.assetsUpdated.join(', ')}`);
  }

  // Refresh UI build from the new release alongside the stack upgrade.
  // state/ui/ is automatically included in the backup taken by performUpgrade.
  const imageTag = result.imageTag ?? state.imageTag;
  if (imageTag) {
    try {
      console.log('Refreshing UI build...');
      await seedUiBuild(imageTag, state.stateDir);
      console.log('UI build refreshed.');
    } catch (err) {
      console.warn(`Warning: UI build refresh failed — existing build still active. Run 'openpalm update' again to retry. (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  console.log('Update complete.');
}
