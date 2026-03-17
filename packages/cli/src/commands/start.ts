import { defineCommand } from 'citty';
import { runDockerCompose } from '../lib/docker.ts';
import { ensureStagedState, fullComposeArgs, buildManagedServiceNames } from '../lib/staging.ts';

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
    'with-admin': {
      type: 'boolean',
      description: 'Include admin UI and docker-socket-proxy (use --no-with-admin to skip)',
      default: true,
    },
  },
  async run({ args }) {
    const services = args._ ?? [];
    const withAdmin = args['with-admin'] ?? false;
    await runStartAction(services, { withAdmin });
  },
});

export async function runStartAction(
  services: string[],
  opts?: { withAdmin?: boolean },
): Promise<void> {
  const withAdmin = opts?.withAdmin ?? false;

  if (services.length === 0) {
    // Stage artifacts and start managed services
    const state = await ensureStagedState();
    const composeArgs = fullComposeArgs(state);
    const managedServices = buildManagedServiceNames(state);

    if (withAdmin) {
      // Include the admin profile — starts admin + docker-socket-proxy
      await runDockerCompose([...composeArgs, '--profile', 'admin', 'up', '-d', ...managedServices, 'admin', 'docker-socket-proxy']);
    } else {
      await runDockerCompose([...composeArgs, 'up', '-d', ...managedServices]);
    }
    return;
  }

  // Start specific services
  for (const service of services) {
    const state = await ensureStagedState();
    const composeArgs = fullComposeArgs(state);
    // If starting admin explicitly, include the admin profile
    if (service === 'admin' || service === 'docker-socket-proxy') {
      await runDockerCompose([...composeArgs, '--profile', 'admin', 'up', '-d', service]);
    } else {
      await runDockerCompose([...composeArgs, 'up', '-d', service]);
    }
  }
}
