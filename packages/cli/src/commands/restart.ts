import { defineCommand } from 'citty';
import { adminRequest, getServiceNames } from '../lib/admin.ts';

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
    const status = await adminRequest('/admin/containers/list');
    const serviceNames = getServiceNames(status);
    for (const service of serviceNames) {
      const result = await adminRequest('/admin/containers/restart', {
        method: 'POST',
        body: JSON.stringify({ service }),
      });
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  for (const service of services) {
    const result = await adminRequest('/admin/containers/restart', {
      method: 'POST',
      body: JSON.stringify({ service }),
    });
    console.log(JSON.stringify(result, null, 2));
  }
}
