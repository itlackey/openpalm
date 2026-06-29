import { defineCommand } from 'citty';
import { runUiBuild } from '../lib/ui-server.ts';

export default defineCommand({
  meta: {
    name: 'ui',
    description:
      'Run the web UI server in the foreground (no auto-update/supervisor). ' +
      'This is the child process the bare `openpalm` supervisor spawns; you can ' +
      'also run it directly to serve the UI as-is.',
  },
  args: {
    port: {
      type: 'string',
      description: 'UI server port (default: 3880 or OP_HOST_UI_PORT)',
    },
  },
  async run({ args }) {
    await runUiBuild({ port: args.port ? Number(args.port) : undefined });
  },
});
