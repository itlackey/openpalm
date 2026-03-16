import { defineCommand } from 'citty';
import { adminRequest } from '../lib/admin.ts';

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show container status',
  },
  async run() {
    console.log(JSON.stringify(await adminRequest('/admin/containers/list'), null, 2));
  },
});
