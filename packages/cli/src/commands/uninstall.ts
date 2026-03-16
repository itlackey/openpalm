import { defineCommand } from 'citty';
import { adminRequest } from '../lib/admin.ts';

export default defineCommand({
  meta: {
    name: 'uninstall',
    description: 'Stop and remove the OpenPalm stack (preserves config and data)',
  },
  async run() {
    console.log(JSON.stringify(await adminRequest('/admin/uninstall', { method: 'POST' }), null, 2));
  },
});
