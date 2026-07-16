/**
 * `openpalm admin` — the CLI admin entry (#556).
 *
 * Serves the existing UI through the existing startUIServer supervisor with
 * the admin capability enabled in the spawned UI child (OP_ENABLE_ADMIN=1),
 * prints the URL, and opens the browser. Full host management from a browser
 * on the host machine, without Electron. Admin capability is an
 * Electron-or-CLI-only security boundary — a served/container build can never
 * self-grant it.
 *
 * Loopback-only ALWAYS: this mode refuses non-loopback bind config —
 * OP_ALLOW_REMOTE_SETUP is ignored and neutralized in the child env (plan
 * §8.3: host admin is never reachable remotely). No new auth mechanism: the
 * UI's existing op_session password auth applies. On a machine with no
 * install, the UI's existing setup guard lands on /setup.
 */
import { defineCommand } from 'citty';
import { startUIServer } from '../lib/ui-server.ts';

export default defineCommand({
  meta: {
    name: 'admin',
    description:
      'Serve the OpenPalm admin UI in your browser (loopback-only, no Electron needed)',
  },
  args: {
    port: {
      type: 'string',
      description: 'UI server port (default: 3880 or OP_HOST_UI_PORT)',
    },
    open: {
      type: 'boolean',
      description: 'Open browser after start (use --no-open to skip)',
      default: true,
    },
  },
  async run({ args }) {
    await startUIServer({
      port: args.port ? Number(args.port) : undefined,
      open: args.open,
      adminHostUi: true,
    });
  },
});
