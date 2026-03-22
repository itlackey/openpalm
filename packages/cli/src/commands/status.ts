import { defineCommand } from 'citty';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeReadOnly } from '../lib/cli-compose.ts';

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
