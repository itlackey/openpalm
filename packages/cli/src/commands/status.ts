import { defineCommand } from 'citty';
import { ensureValidState, runComposeWithPreflight } from '../lib/staging.ts';

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show container status',
  },
  async run() {
    const state = await ensureValidState();
    await runComposeWithPreflight(state, ['ps', '--format', 'table']);
  },
});
