import { defineCommand } from 'citty';
import { runDockerCompose } from '../lib/docker.ts';
import { ensureStagedState, fullComposeArgs } from '../lib/staging.ts';

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show container status',
  },
  async run() {
    const state = await ensureStagedState();
    await runDockerCompose([...fullComposeArgs(state), 'ps', '--format', 'table']);
  },
});
