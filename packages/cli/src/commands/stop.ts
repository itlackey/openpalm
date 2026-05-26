import { defineCommand } from 'citty';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeWithPreflight } from '../lib/cli-compose.ts';

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
  async run({ args }) {
    try {
      const services = args._ ?? [];
      await runStopAction(services);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
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
