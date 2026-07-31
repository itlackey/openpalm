import { defineCommand } from 'citty';
import {
  buildManagedServices,
  reconcileHostOwnership,
  acquireInstallLock,
  releaseInstallLock,
  teardownRenamedProject,
  classifyLocalInstall,
  markSetupComplete,
  readStackEnv,
  composePs,
  parseComposePsRows,
  buildComposeOptions,
  CORE_SERVICES,
} from '@openpalm/lib';
import type { ControlPlaneState } from '@openpalm/lib';
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

/**
 * `performSetup` intentionally defers `OP_SETUP_COMPLETE` to the deploy
 * callback that fires once `compose up --wait` confirms the CORE services are
 * healthy (deploy.ts) — writing it earlier would mark setup "complete" even
 * when containers fail to start. `install --file --no-start` runs
 * performSetup but never deploys, so that callback never fires; a later
 * `openpalm start` bringing up the SAME configured stack must fire the
 * equivalent stamp itself, or the home stays `setup_incomplete` forever (C2)
 * and `openpalm admin` bounces the operator into the wizard over their
 * already-finished config.
 *
 * Mirrors the deploy contract's evidence bar rather than trusting a bare
 * `compose up -d` exit code: `classifyLocalInstall` must already see this
 * home as more than a never-configured skeleton (not `not_installed`), AND
 * the just-started core services must show up healthy on a follow-up
 * `compose ps` — `up -d` alone (no `--wait` here) proves containers were
 * created, not that they stayed up.
 */
async function markSetupCompleteIfHealthy(state: ControlPlaneState): Promise<void> {
  if (readStackEnv(state.homeDir).OP_SETUP_COMPLETE === 'true') return;
  if (classifyLocalInstall(state.stackDir, state.homeDir) === 'not_installed') return;
  const ps = await composePs(buildComposeOptions(state));
  if (!ps.ok) return;
  const rows = parseComposePsRows(ps.stdout);
  const coreHealthy = CORE_SERVICES.every((service) => {
    const row = rows.find((r) => r.service === service);
    return (
      row?.state.toLowerCase() === 'running' &&
      (row.health === '' || row.health.toLowerCase() === 'healthy')
    );
  });
  if (coreHealthy) markSetupComplete(state);
}

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
      await markSetupCompleteIfHealthy(state);
      return;
    }

    // Start specific services
    for (const service of services) {
      await runComposeWithPreflight(state, ['up', '-d', service], lock);
    }
    await markSetupCompleteIfHealthy(state);
  } finally {
    releaseInstallLock(lock);
  }
}
