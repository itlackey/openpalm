import { defineCommand } from 'citty';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeReadOnly } from '../lib/cli-compose.ts';

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show container status',
  },
  async run() {
    try {
      const state = ensureValidState();
      await runComposeReadOnly(state, ['ps', '--format', 'table']);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
