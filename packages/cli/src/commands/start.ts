import { defineCommand } from 'citty';
import {
  buildManagedServices,
  reconcileHostOwnership,
  acquireInstallLock,
  releaseInstallLock,
  teardownRenamedProject,
} from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeWithPreflight } from '../lib/cli-compose.ts';
import { defineAction } from '../lib/action.ts';

export default defineCommand({
  meta: {
    name: 'start',
    description: 'Start services (all or named)',
  },
  args: {
    services: {
      type: 'positional',
      description: 'Service names to start (omit for all)',
      required: false,
    },
    adoptHost: {
      type: 'boolean',
      description:
        'Repair bind-mount ownership for the current host before start. Also the ' +
        'recovery path if containers keep failing with permission errors after an ' +
        'automatic repair silently failed — this forces a full repair and surfaces ' +
        'the underlying error instead of retrying quietly.',
      default: false,
    },
  },
  run: defineAction(async ({ args }) => {
    const services = args._ ?? [];
    await runStartAction(services, { adoptHost: !!args.adoptHost });
  }),
});

export async function runStartAction(
  services: string[],
  options: { adoptHost?: boolean } = {},
): Promise<void> {
  const state = ensureValidState();

  // Hold the install lock across the compose-up calls so a concurrent
  // install/update (which also drives compose) can't interleave with this
  // start and recreate containers out from under it.
  const lock = acquireInstallLock(state.dataDir);
  if (!lock) {
    throw new Error(
      "install_in_progress: Another install or update is already running. Wait for it to finish, or run 'openpalm unlock' to clear a stale lock.",
    );
  }
  try {
    // Ownership repair can mutate bind mounts and state, so it belongs inside
    // the same orchestrator transaction as compose.
    const managedServices = services.length === 0 ? await buildManagedServices(state) : services;
    await reconcileHostOwnership(state, { adoptHost: !!options.adoptHost, services: managedServices });
    if (services.length === 0) {
      // Project rename (#540): if OP_PROJECT_NAME changed since the stack
      // last came up, stop the recorded outgoing project first — otherwise
      // its containers keep running (and holding host ports) under the old
      // name while this `up` creates a second stack under the new one. A
      // blocked teardown aborts the start rather than creating that collision.
      const renameTeardown = await teardownRenamedProject(state);
      if (renameTeardown.blocked) {
        throw new Error(renameTeardown.warning ?? 'Project rename teardown failed.');
      }
      if (renameTeardown.warning) console.warn(renameTeardown.warning);
      if (renameTeardown.downed) {
        console.log(`Project rename: stopped previous docker project "${renameTeardown.downed}".`);
      }

      // Stage artifacts and start all managed services (admin included if enabled)
      await runComposeWithPreflight(state, ['up', '-d', ...managedServices], lock);
      return;
    }

    // Start specific services
    for (const service of services) {
      await runComposeWithPreflight(state, ['up', '-d', service], lock);
    }
  } finally {
    releaseInstallLock(lock);
  }
}
