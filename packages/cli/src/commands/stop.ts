import { defineCommand } from 'citty';
import { adminRequest, isStackRunning } from '../lib/admin.ts';
import { loadAdminToken } from '../lib/env.ts';
import { runDockerCompose, composeProjectArgs } from '../lib/docker.ts';

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
    const running = await isStackRunning();
    const token = await loadAdminToken();
    if (running && token) {
      console.log(JSON.stringify(await adminRequest('/admin/uninstall', { method: 'POST' }), null, 2));
      return;
    }

    // Direct docker compose — works without auth
    await runDockerCompose([...composeProjectArgs(), 'down']);
    return;
  }

  for (const service of services) {
    const result = await adminRequest('/admin/containers/down', {
      method: 'POST',
      body: JSON.stringify({ service }),
    });
    console.log(JSON.stringify(result, null, 2));
  }
}
