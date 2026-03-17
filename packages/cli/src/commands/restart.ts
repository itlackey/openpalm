import { defineCommand } from 'citty';
import { tryAdminRequest, getServiceNames } from '../lib/admin.ts';
import { runDockerCompose } from '../lib/docker.ts';
import { ensureStagedState, fullComposeArgs, buildManagedServiceNames } from '../lib/staging.ts';

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
    // Try admin delegation first
    const adminResult = await tryAdminRequest('/admin/containers/list');
    if (adminResult !== null) {
      const serviceNames = getServiceNames(adminResult);
      for (const service of serviceNames) {
        const result = await tryAdminRequest('/admin/containers/restart', {
          method: 'POST',
          body: JSON.stringify({ service }),
        });
        if (result !== null) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.warn(`Warning: failed to restart ${service} via admin API`);
        }
      }
      return;
    }

    // Direct compose restart
    const state = await ensureStagedState();
    const managedServices = buildManagedServiceNames(state);
    await runDockerCompose([...fullComposeArgs(state), 'restart', ...managedServices]);
    return;
  }

  // Restart specific services
  for (const service of services) {
    const adminResult = await tryAdminRequest('/admin/containers/restart', {
      method: 'POST',
      body: JSON.stringify({ service }),
    });
    if (adminResult !== null) {
      console.log(JSON.stringify(adminResult, null, 2));
      continue;
    }

    // Direct compose restart for specific service
    const state = await ensureStagedState();
    const composeArgs = fullComposeArgs(state);
    if (service === 'admin' || service === 'docker-socket-proxy') {
      await runDockerCompose([...composeArgs, '--profile', 'admin', 'restart', service]);
    } else {
      await runDockerCompose([...composeArgs, 'restart', service]);
    }
  }
}
