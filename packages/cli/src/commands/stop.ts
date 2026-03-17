import { defineCommand } from 'citty';
import { tryAdminRequest, getServiceNames } from '../lib/admin.ts';
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
    // Try admin delegation — stop each managed container
    const adminResult = await tryAdminRequest('/admin/containers/list');
    if (adminResult !== null) {
      const serviceNames = getServiceNames(adminResult);
      for (const service of serviceNames) {
        const result = await tryAdminRequest('/admin/containers/down', {
          method: 'POST',
          body: JSON.stringify({ service }),
        });
        if (result !== null) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.warn(`Warning: failed to stop ${service} via admin API`);
        }
      }
      return;
    }

    // Direct compose down — include admin profile to tear down all services
    const state = await ensureStagedState();
    await runDockerCompose([...fullComposeArgs(state), '--profile', 'admin', 'down']);
    return;
  }

  // Stop specific services
  for (const service of services) {
    const adminResult = await tryAdminRequest('/admin/containers/down', {
      method: 'POST',
      body: JSON.stringify({ service }),
    });
    if (adminResult !== null) {
      console.log(JSON.stringify(adminResult, null, 2));
      continue;
    }

    // Direct compose stop for specific service
    const state = await ensureStagedState();
    const composeArgs = fullComposeArgs(state);
    if (service === 'admin' || service === 'docker-socket-proxy') {
      await runDockerCompose([...composeArgs, '--profile', 'admin', 'stop', service]);
    } else {
      await runDockerCompose([...composeArgs, 'stop', service]);
    }
  }
}
