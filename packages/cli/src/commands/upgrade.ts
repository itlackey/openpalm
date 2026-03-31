import { defineCommand } from 'citty';
import { runUpgradeAction } from './update.ts';

export default defineCommand({
  meta: {
    name: 'upgrade',
    description: 'Refresh stack assets, pull latest images, and recreate containers',
  },
  async run() {
    await runUpgradeAction();
  },
});
