import { defineCommand } from 'citty';
import { ensureValidState, buildManagedServiceNames, runComposeWithPreflight } from '../lib/staging.ts';

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
  async run({ args }) {
    const services = args._ ?? [];
    await runRestartAction(services);
  },
});

export async function runRestartAction(services: string[]): Promise<void> {
  if (services.length === 0) {
    // Restart all managed services (admin included if enabled)
    const state = await ensureValidState();
    const managedServices = await buildManagedServiceNames(state);
    await runComposeWithPreflight(state, ['restart', ...managedServices]);
    return;
  }

  for (const service of services) {
    const state = await ensureValidState();
    await runComposeWithPreflight(state, ['restart', service]);
  }
}
