import { defineCommand } from 'citty';
import { adminRequest } from '../lib/admin.ts';

export default defineCommand({
  meta: {
    name: 'update',
    description: 'Pull latest images and recreate containers',
  },
  async run() {
    console.log(JSON.stringify(await adminRequest('/admin/containers/pull', { method: 'POST' }), null, 2));
  },
});
