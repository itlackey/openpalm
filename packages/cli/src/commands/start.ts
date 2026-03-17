import { defineCommand } from 'citty';
import { tryAdminRequest } from '../lib/admin.ts';
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
    // Try admin delegation first (gives admin's scheduler/audit a chance to observe)
    const adminResult = await tryAdminRequest('/admin/install', { method: 'POST' });
    if (adminResult !== null) {
      console.log(JSON.stringify(adminResult, null, 2));
      return;
    }

    // Direct compose — stage artifacts and start managed services
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

  // Start specific services — try admin first, fall back to direct compose
  for (const service of services) {
    const adminResult = await tryAdminRequest('/admin/containers/up', {
      method: 'POST',
      body: JSON.stringify({ service }),
    });
    if (adminResult !== null) {
      console.log(JSON.stringify(adminResult, null, 2));
      continue;
    }

    // Direct compose for specific service
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
