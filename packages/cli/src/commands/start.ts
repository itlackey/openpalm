import { defineCommand } from 'citty';
import { ensureValidState } from '../lib/cli-state.ts';
import { buildManagedServiceNames, runComposeWithPreflight } from '../lib/cli-compose.ts';

export default defineCommand({
  meta: {
    name: 'start',
    description: 'Start services (all or named)',
  },
  args: {
    services: {
      type: 'positional',
      description: 'Service names to start (omit for all)',
      required: false,
    },
  },
  async run({ args }) {
    const services = args._ ?? [];
    await runStartAction(services);
  },
});

export async function runStartAction(
  services: string[],
): Promise<void> {
  if (services.length === 0) {
    // Stage artifacts and start all managed services (admin included if enabled)
    const state = await ensureValidState();
    const managedServices = await buildManagedServiceNames(state);
    await runComposeWithPreflight(state, ['up', '-d', ...managedServices]);
    return;
  }

  // Start specific services
  const state = await ensureValidState();
  for (const service of services) {
    await runComposeWithPreflight(state, ['up', '-d', service]);
  }
}
