import { defineCommand } from 'citty';
import {
  buildManagedServices,
  buildReconcileDecision,
  detectHostIdentity,
  hostIdentityFile,
  ownershipRepairPaths,
  readHostIdentity,
  repairRootOwnedBindMounts,
  writeHostIdentity,
} from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeWithPreflight } from '../lib/cli-compose.ts';

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
      description: 'Repair bind-mount ownership for the current host before start',
      default: false,
    },
    readOnly: {
      type: 'boolean',
      description: 'Start without ownership repair when a host swap is detected',
      default: false,
    },
  },
  async run({ args }) {
    try {
      const services = args._ ?? [];
      await runStartAction(services, { adoptHost: !!args.adoptHost, readOnly: !!args.readOnly });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

export async function runStartAction(
  services: string[],
  options: { adoptHost?: boolean; readOnly?: boolean } = {},
): Promise<void> {
  const state = ensureValidState();
  const currentIdentity = detectHostIdentity(state.homeDir);
  const previousIdentity = readHostIdentity(hostIdentityFile(state.homeDir));
  const reconcile = buildReconcileDecision({ state, currentIdentity, previousIdentity });

  if (reconcile.decision === 'swap' && !options.adoptHost && !options.readOnly) {
    const prev = previousIdentity
      ? `${previousIdentity.kind} ${previousIdentity.host} uid=${previousIdentity.uid ?? 'unknown'} gid=${previousIdentity.gid ?? 'unknown'}`
      : 'unknown host';
    const curr = `${currentIdentity.kind} ${currentIdentity.host} uid=${currentIdentity.uid ?? 'unknown'} gid=${currentIdentity.gid ?? 'unknown'}`;
    throw new Error(
      `Host swap detected for OP_HOME. Previous: ${prev}. Current: ${curr}. ` +
      'Re-run with `--adopt-host` to repair ownership for this host, or `--read-only` to start without repair.',
    );
  }

  if (!options.readOnly && (reconcile.decision === 'drift' || (reconcile.decision === 'swap' && options.adoptHost))) {
    await repairRootOwnedBindMounts(state.homeDir, ownershipRepairPaths(state), { strict: !!options.adoptHost });
  }

  if (services.length === 0) {
    // Stage artifacts and start all managed services (admin included if enabled)
    const managedServices = await buildManagedServices(state);
    await runComposeWithPreflight(state, ['up', '-d', ...managedServices]);
    if (!options.readOnly) writeHostIdentity(hostIdentityFile(state.homeDir), currentIdentity);
    return;
  }

  // Start specific services
  for (const service of services) {
    await runComposeWithPreflight(state, ['up', '-d', service]);
  }
  if (!options.readOnly) writeHostIdentity(hostIdentityFile(state.homeDir), currentIdentity);
}
