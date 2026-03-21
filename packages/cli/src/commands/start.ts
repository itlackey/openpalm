import { defineCommand } from 'citty';
import { runDockerCompose } from '../lib/docker.ts';
import { ensureValidState, fullComposeArgs, buildManagedServiceNames } from '../lib/staging.ts';

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
    const composeArgs = fullComposeArgs(state);
    const managedServices = await buildManagedServiceNames(state);
    await runDockerCompose([...composeArgs, 'up', '-d', ...managedServices]);
    return;
  }

  // Start specific services
  for (const service of services) {
    const state = await ensureValidState();
    const composeArgs = fullComposeArgs(state);
    await runDockerCompose([...composeArgs, 'up', '-d', service]);
  }
}
