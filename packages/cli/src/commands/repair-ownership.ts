import { defineCommand } from 'citty';
import {
  buildManagedServices,
  reconcileHostOwnership,
} from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';
import { defineAction } from '../lib/action.ts';

export default defineCommand({
  meta: {
    name: 'repair-ownership',
    description:
      'Repair bind-mount and named-volume ownership for the current host, without starting any services',
  },
  args: {
    adopt: {
      type: 'boolean',
      description:
        'Adopt this host after a detected host-identity swap (chown bind mounts + named volumes to the current session uid/gid) instead of blocking',
      default: false,
    },
  },
  run: defineAction(async ({ args }) => {
    await runRepairOwnershipAction({ adopt: !!args.adopt });
  }),
});

/**
 * Explicit ownership-repair entry point (R2 restructure): the same shared lib
 * reconcile `openpalm start` and every lifecycle upgrade run — swap
 * detection, deep bind-mount + named-volume repair, adopt env patch, marker,
 * identity record — invoked standalone so an operator (or a support runbook)
 * can repair ownership without also starting/recreating containers. The CLI
 * stays a thin caller; all reasoning lives in `reconcileHostOwnership`.
 */
export async function runRepairOwnershipAction(
  options: { adopt?: boolean } = {},
): Promise<void> {
  const state = ensureValidState();
  const managedServices = await buildManagedServices(state);
  await reconcileHostOwnership(state, { adoptHost: !!options.adopt, services: managedServices });
  console.log('Ownership repair complete.');
}
