import { defineCommand } from 'citty';
import { buildManagedServices } from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeWithPreflight } from '../lib/cli-compose.ts';
import { defineAction } from '../lib/action.ts';

export default defineCommand({
  meta: {
    name: 'restart',
    description: 'Restart services (all or named)',
  },
  args: {
    services: {
      type: 'positional',
      description: 'Service names to restart (omit for all)',
      required: false,
    },
  },
  run: defineAction(async ({ args }) => {
    const services = args._ ?? [];
    await runRestartAction(services);
  }),
});

export async function runRestartAction(services: string[]): Promise<void> {
  if (services.length === 0) {
    // Restart all managed services (admin included if enabled)
    const state = ensureValidState();
    const managedServices = await buildManagedServices(state);
    await runComposeWithPreflight(state, ['restart', ...managedServices]);
    return;
  }

  const state = ensureValidState();
  for (const service of services) {
    await runComposeWithPreflight(state, ['restart', service]);
  }
}
