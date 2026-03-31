import { defineCommand } from 'citty';
import { performUpgrade } from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';

export default defineCommand({
  meta: {
    name: 'update',
    description: 'Pull latest images and recreate containers',
  },
  async run() {
    const state = await ensureValidState();

    console.log('Upgrading stack...');
    const result = await performUpgrade(state);
    console.log(`Image tag: ${result.namespace}/*:${result.imageTag}`);
    if (result.assetsUpdated.length > 0) {
      console.log(`Assets updated: ${result.assetsUpdated.join(', ')}`);
    }
    console.log('Update complete.');
  },
});
