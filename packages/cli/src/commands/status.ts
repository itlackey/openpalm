import { defineCommand } from 'citty';
import { runDockerCompose } from '../lib/docker.ts';
import { ensureValidState, fullComposeArgs } from '../lib/staging.ts';

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show container status',
  },
  async run() {
    const state = await ensureValidState();
    await runDockerCompose([...fullComposeArgs(state), 'ps', '--format', 'table']);
  },
});
