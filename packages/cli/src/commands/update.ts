import { defineCommand } from 'citty';
import { join } from 'node:path';
import {
  performUpgrade,
  classifyLocalInstall,
  createState,
  detectCliVersionSkew,
  isRollbackRecoveryFailure,
  type ControlPlaneState,
} from '@openpalm/lib';
import cliPkg from '../../package.json' with { type: 'json' };
import { seedSkeletonFromEmbedded } from '../lib/embedded-assets.ts';

// #667: distinct from the CLI's generic exit(1) (defineAction) — this command
// needs a LOUDER code for the specific case that lied about success before:
// the upgrade failed AND the automatic rollback did not fully recover, so the
// stack is likely down. A plain refusal (bad --allow-version-skew, not
// installed, upgrade failed but rollback DID recover) still exits 1.
const EXIT_STACK_DOWN = 3;

export default defineCommand({
  meta: {
    name: 'update',
    description: 'Refresh stack assets and safely reapply running containers',
  },
  args: {
    allowVersionSkew: {
      type: 'boolean',
      description:
        'Proceed even when this CLI is older than the release it is about to deploy (see `openpalm self-update`).',
      default: false,
    },
  },
  async run({ args }) {
    try {
      await runUpgradeAction({ allowVersionSkew: !!args.allowVersionSkew });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const outcome = describeUpgradeFailure(err);
      console.error(message);
      console.error(outcome.finalStateLine);
      process.exit(outcome.exitCode);
    }
  },
});

export type UpgradeFailureOutcome = {
  /** #667: one final line naming the ACTUAL end state, never a one-size-fits-all hint. */
  finalStateLine: string;
  exitCode: number;
};

/**
 * #667: `openpalm update` used to print whatever the error said and always
 * exit(1) via `defineAction` — indistinguishable whether the automatic
 * rollback recovered or not. This is the one place that decision is made, so
 * it is testable without driving a real (Docker-dependent) upgrade or a real
 * `process.exit`.
 */
export function describeUpgradeFailure(err: unknown): UpgradeFailureOutcome {
  if (isRollbackRecoveryFailure(err)) {
    return {
      exitCode: EXIT_STACK_DOWN,
      finalStateLine:
        'End state: the update failed and the automatic rollback did NOT fully recover — the stack is likely DOWN. ' +
        'Resolve the error above, then run `openpalm start` or `openpalm rollback` to try again.',
    };
  }
  return {
    exitCode: 1,
    finalStateLine:
      'If something went wrong, your previous state was backed up before this update — run `openpalm rollback` to restore it.',
  };
}

/**
 * #662: refuse before touching anything (B8/#664's own rule) when this CLI is
 * OLDER than the release it is about to pin the stack to — the update
 * command's normal successful outcome would otherwise be an old CLI newly
 * managing a newer stack, exactly the pairing #636's downgrade guard treats
 * as dangerous from the other direction. A newer (or equal) CLI is the
 * ordinary upgrade direction and stays unguarded. Split out from
 * runUpgradeAction so the comparison is testable without driving a full
 * (Docker-dependent) upgrade.
 */
export function assertCliVersionAllowsUpgrade(cliVersion: string, allowVersionSkew: boolean): void {
  const skew = detectCliVersionSkew(cliVersion);
  if (!skew.older || allowVersionSkew) return;
  throw new Error(
    `This openpalm CLI is ${skew.cliVersion}, older than the ${skew.targetVersion} release it is about to deploy. ` +
      'Run `openpalm self-update` first, then retry `openpalm update` — or pass --allow-version-skew to proceed anyway.',
  );
}

export async function runUpgradeAction(opts: { allowVersionSkew?: boolean } = {}): Promise<void> {
  const state = resolveUpgradeState();
  assertCliVersionAllowsUpgrade(cliPkg.version, !!opts.allowVersionSkew);

  console.log('Updating stack...');
  // A compiled binary ships its skeleton INSIDE the executable — materialize it
  // and point OPENPALM_SKELETON_DIR at it for the duration of the upgrade, the
  // same way the install and serve paths do (see embedded-assets.ts). Without
  // this, performUpgrade's applyHomeSeed has no local skeleton source and the
  // update would bump image versions against the previous release's compose
  // tree. In a repo checkout there is nothing embedded and the callback runs
  // against the local skeleton resolution instead.
  await seedSkeletonFromEmbedded(
    async () => { await performUpgrade(state); },
    state.homeDir,
    state.dataDir,
  );

  // The UI build ships INSIDE this binary now (see embedded-assets.ts) — the
  // running `openpalm`/`openpalm admin` supervisor materializes it into
  // data/ui on its next spawn. Updating the CLI itself means replacing the
  // binary (see the install docs), not downloading a separate UI release.
  console.log('Update complete. To update the CLI itself, install a newer openpalm binary.');
}

export function resolveUpgradeState(): ControlPlaneState {
  const state = createState();
  const currentInstall = classifyLocalInstall(state.stackDir, state.homeDir);
  const legacyStackDir = join(state.homeDir, 'config', 'stack');
  const legacyInstall = classifyLocalInstall(legacyStackDir, state.homeDir);
  if (currentInstall === 'not_installed' && legacyInstall === 'not_installed') {
    throw new Error('OpenPalm is not installed in this OP_HOME yet. Run `openpalm install` first.');
  }
  return state;
}
