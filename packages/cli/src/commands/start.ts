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
  },
  async run({ args }) {
    const services = args._ ?? [];
    await runStartAction(services);
  },
});

export async function runStartAction(services: string[]): Promise<void> {
  if (services.length === 0) {
    // Try admin delegation first (gives admin's scheduler/audit a chance to observe)
    const adminResult = await tryAdminRequest('/admin/install', { method: 'POST' });
    if (adminResult !== null) {
      console.log(JSON.stringify(adminResult, null, 2));
      return;
    }

    // Direct compose — stage artifacts and start all managed services
    const state = await ensureStagedState();
    const managedServices = buildManagedServiceNames(state);
    await runDockerCompose([...fullComposeArgs(state), 'up', '-d', ...managedServices]);
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
    await runDockerCompose([...fullComposeArgs(state), 'up', '-d', service]);
  }
}
