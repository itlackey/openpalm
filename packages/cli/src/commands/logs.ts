import { defineCommand } from 'citty';
import { ensureValidState, runComposeReadOnly } from '../lib/staging.ts';

export async function runLogsAction(services: string[]): Promise<void> {
  const state = await ensureValidState();
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
  async run({ args }) {
    await runLogsAction(args._ ?? []);
  },
});
