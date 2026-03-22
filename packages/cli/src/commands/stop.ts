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
    const services = args._ ?? [];
    await runStopAction(services);
  },
});

export async function runStopAction(services: string[]): Promise<void> {
  if (services.length === 0) {
    // Compose file list includes admin.yml when admin is enabled,
    // so `down` tears down all services including admin/socket-proxy.
    const state = await ensureValidState();
    await runComposeWithPreflight(state, ['down']);
    return;
  }

  for (const service of services) {
    const state = await ensureValidState();
    await runComposeWithPreflight(state, ['stop', service]);
  }
}
