import { defineCommand } from 'citty';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeWithPreflight } from '../lib/cli-compose.ts';
import { defineAction } from '../lib/action.ts';

export default defineCommand({
  meta: {
    name: 'stop',
    description: 'Stop services (all or named)',
  },
  args: {
    services: {
      type: 'positional',
      description: 'Service names to stop (omit for all)',
      required: false,
    },
  },
  run: defineAction(async ({ args }) => {
    const services = args._ ?? [];
    await runStopAction(services);
  }),
});

export async function runStopAction(services: string[]): Promise<void> {
  if (services.length === 0) {
    const state = ensureValidState();
    await runComposeWithPreflight(state, ['down']);
    return;
  }

  const state = ensureValidState();
  for (const service of services) {
    await runComposeWithPreflight(state, ['stop', service]);
  }
}
