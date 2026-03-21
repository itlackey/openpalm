import { defineCommand } from 'citty';
import { runDockerCompose } from '../lib/docker.ts';
import { ensureValidState, fullComposeArgs, buildManagedServiceNames } from '../lib/staging.ts';

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
    await runDockerCompose([...fullComposeArgs(state), 'restart', ...managedServices]);
    return;
  }

  // Restart specific services
  for (const service of services) {
    const state = await ensureValidState();
    const composeArgs = fullComposeArgs(state);
    await runDockerCompose([...composeArgs, 'restart', service]);
  }
}
