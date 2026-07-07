import { defineCommand } from 'citty';
import { startUIServer, type UIServerOptions } from '../lib/ui-server.ts';

export async function runAppCommand(
  start = (options: UIServerOptions) => startUIServer(options),
): Promise<void> {
  await start({ openTarget: 'client' });
}

export default defineCommand({
  meta: {
    name: 'app',
    description: 'Open the localhost OpenPalm app at the stable loopback client origin',
  },
  async run() {
    await runAppCommand();
  },
});
