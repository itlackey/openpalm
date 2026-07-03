import { defineCommand } from 'citty';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeReadOnly } from '../lib/cli-compose.ts';
import { defineAction } from '../lib/action.ts';

export async function runLogsAction(services: string[]): Promise<void> {
  const state = ensureValidState();
  await runComposeReadOnly(state, ['logs', '--tail', '100', ...services]);
}

export default defineCommand({
  meta: {
    name: 'logs',
    description: 'Tail last 100 log lines for services',
  },
  args: {
    services: {
      type: 'positional',
      description: 'Service names (omit for all)',
      required: false,
    },
  },
  run: defineAction(async ({ args }) => {
    await runLogsAction(args._ ?? []);
  }),
});
