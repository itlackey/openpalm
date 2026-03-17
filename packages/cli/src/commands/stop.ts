import { defineCommand } from 'citty';
import { tryAdminRequest } from '../lib/admin.ts';
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
    // Try admin delegation first
    const adminResult = await tryAdminRequest('/admin/uninstall', { method: 'POST' });
    if (adminResult !== null) {
      console.log(JSON.stringify(adminResult, null, 2));
      return;
    }

    // Direct compose down
    const state = await ensureStagedState();
    await runDockerCompose([...fullComposeArgs(state), 'down']);
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
    await runDockerCompose([...fullComposeArgs(state), 'stop', service]);
  }
}
