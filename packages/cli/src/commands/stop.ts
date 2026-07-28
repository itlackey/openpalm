import { defineCommand } from 'citty';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeWithPreflight } from '../lib/cli-compose.ts';
import { defineAction } from '../lib/action.ts';
import { acquireInstallLock, releaseInstallLock } from '@openpalm/lib';

export default defineCommand({
  meta: {
    name: 'stop',
    description: 'Stop services (all or named)',
  },
  args: {
    services: {
      type: 'positional',
      description: 'Service names to stop (omit for all)',
      required: false,
    },
  },
  run: defineAction(async ({ args }) => {
    const services = args._ ?? [];
    await runStopAction(services);
  }),
});

export async function runStopAction(services: string[]): Promise<void> {
  const state = ensureValidState();
  const lock = acquireInstallLock(state.dataDir);
  if (!lock) throw new Error('install_in_progress: Another lifecycle operation is already running.');
  try {
  if (services.length === 0) {
    await runComposeWithPreflight(state, ['down'], lock);
    return;
  }

  for (const service of services) {
    await runComposeWithPreflight(state, ['stop', service], lock);
  }
  } finally {
    releaseInstallLock(lock);
  }
}
