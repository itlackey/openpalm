import { defineCommand } from 'citty';
import { runDockerCompose } from '../lib/docker.ts';
import { ensureStagedState, fullComposeArgs } from '../lib/staging.ts';

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
    const state = await ensureStagedState();
    await runDockerCompose([...fullComposeArgs(state), 'down']);
    return;
  }

  // Stop specific services
  for (const service of services) {
    const state = await ensureStagedState();
    const composeArgs = fullComposeArgs(state);
    await runDockerCompose([...composeArgs, 'stop', service]);
  }
}
