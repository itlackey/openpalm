import { defineCommand } from 'citty';
import { startUIServer, type UIServerOptions } from '../lib/ui-server.ts';

export async function runAppCommand(
  start = (options: UIServerOptions) => startUIServer(options),
): Promise<void> {
  await start({ allowUninstalled: true });
}

export default defineCommand({
  meta: {
    name: 'app',
    description: 'Open the full OpenPalm app',
  },
  async run() {
    await runAppCommand();
  },
});
