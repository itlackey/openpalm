import { defineCommand } from 'citty';
import { performUpgrade } from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';

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
  const state = await ensureValidState();

  console.log('Upgrading stack...');
  const result = await performUpgrade(state);
  console.log(`Image tag: ${result.namespace}/*:${result.imageTag}`);
  if (result.assetsUpdated.length > 0) {
    console.log(`Assets updated: ${result.assetsUpdated.join(', ')}`);
  }
  console.log('Update complete.');
}
