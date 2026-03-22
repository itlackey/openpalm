import { defineCommand } from 'citty';
import { ensureValidState, runComposeReadOnly } from '../lib/staging.ts';

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show container status',
  },
  async run() {
    const state = await ensureValidState();
    await runComposeReadOnly(state, ['ps', '--format', 'table']);
  },
});
