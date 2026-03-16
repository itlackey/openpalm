import { defineCommand } from 'citty';
import { adminRequest, isStackRunning } from '../lib/admin.ts';
import { loadAdminToken } from '../lib/env.ts';
import { runDockerCompose, composeProjectArgs } from '../lib/docker.ts';

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
    // If admin is reachable and we have a token, use the admin API.
    // Otherwise fall back to docker compose up directly — this handles
    // the fresh-install case where no token exists yet.
    const running = await isStackRunning();
    const token = await loadAdminToken();
    if (running && token) {
      console.log(JSON.stringify(await adminRequest('/admin/install', { method: 'POST' }), null, 2));
      return;
    }

    // Direct docker compose — works without auth
    await runDockerCompose([...composeProjectArgs(), 'up', '-d']);
    return;
  }

  for (const service of services) {
    const result = await adminRequest('/admin/containers/up', {
      method: 'POST',
      body: JSON.stringify({ service }),
    });
    console.log(JSON.stringify(result, null, 2));
  }
}
