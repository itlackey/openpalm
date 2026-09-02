import { defineCommand } from 'citty';
import { accessSync, constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  performUpgrade,
  classifyLocalInstall,
  createState,
  detectCliVersionSkew,
  isComparableSemver,
  isRollbackRecoveryFailure,
  readVersions,
  SERVICE_VERSION_KEYS,
  type ControlPlaneState,
} from '@openpalm/lib';
import cliPkg from '../../package.json' with { type: 'json' };
import { seedSkeletonFromEmbedded } from '../lib/embedded-assets.ts';
import { resolveLatestReleaseTag } from '../lib/github.ts';
import {
  canReplaceCurrentExecutable,
  downloadVerifiedBinary,
  replaceExecutableInPlace,
  resolveCliArtifactName,
} from './self-update.ts';

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
        'Proceed even when this CLI cannot be brought current before deploying (see phase 1 below).',
      default: false,
    },
    noSelfUpdate: {
      type: 'boolean',
      description:
        'Skip the CLI-currency check entirely and run the stack upgrade with this CLI as-is (0.13.2 behavior).',
      default: false,
    },
  },
  async run({ args }) {
    try {
      await runUpgradeAction({
        allowVersionSkew: !!args.allowVersionSkew,
        noSelfUpdate: !!args.noSelfUpdate,
      });
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
  if (err instanceof CliCurrencyError) {
    return {
      exitCode: 1,
      finalStateLine: 'End state: nothing was changed — the update stopped before touching the stack.',
    };
  }
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

// ── Phase 1: make the CLI current before it deploys anything (#674) ─────────
//
// #662 (the guard this replaces) compared `cliPkg.version` against
// `PLATFORM_VERSION` — in a compiled binary both are stamped from the SAME
// build, so an old CLI's own guard could never see itself as old; it only
// ever caught a dev checkout with a hand-edited package.json. The real fix
// is to make an old CLI current FIRST, then run the ordinary (now unguarded)
// upgrade with a binary that is no longer old. `performUpgrade` deploys ITS
// OWN `PLATFORM_VERSION` (`setPlatformImageVersions`), so
// this is what actually prevents an old CLI from deploying an old stack —
// #662's comparison alone never could.

export type EnsureCliCurrentResult =
  | { action: 'skip' }
  | { action: 'current' }
  /** Phase 1 could not run to completion but `--allow-version-skew` was set; `reason` is the one-line warning to print before proceeding with the CLI as-is. */
  | { action: 'fallback'; reason: string }
  /** The binary was replaced and re-exec'd; the caller MUST `process.exit(exitCode)` — this process's own copy of the CLI is now stale. */
  | { action: 'reexec'; exitCode: number };

export type EnsureCliCurrentDeps = {
  resolveLatestTag: () => Promise<string | null>;
  downloadBinary: (tag: string) => Promise<string>;
  replaceExecutable: (tempBinary: string, execPath: string) => void;
  reexec: (argv: string[]) => number;
  canReplace: (execPath: string) => boolean;
  canWriteDir: (dir: string) => boolean;
  platform: NodeJS.Platform;
  execPath: string;
};

function defaultCanWriteDir(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultReexec(argv: string[]): number {
  const child = Bun.spawnSync([process.execPath, ...argv], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return child.exitCode ?? 1;
}

export const defaultEnsureCliCurrentDeps: EnsureCliCurrentDeps = {
  resolveLatestTag: () => resolveLatestReleaseTag(),
  downloadBinary: (tag) => downloadVerifiedBinary(tag, resolveCliArtifactName()),
  replaceExecutable: replaceExecutableInPlace,
  reexec: defaultReexec,
  canReplace: canReplaceCurrentExecutable,
  canWriteDir: defaultCanWriteDir,
  platform: process.platform,
  execPath: process.execPath,
};

/** Thrown by phase 1 (#674): the update stopped before touching the stack, so no rollback hint applies. */
export class CliCurrencyError extends Error {}

/**
 * #674 phase 1. Resolves the latest published release, and when this CLI is
 * OLDER than it, replaces the installed binary in place and re-execs into it
 * with the original argv — so by the time phase 2 (the stack upgrade) runs,
 * it is always running the CLI it is about to deploy, never an older one.
 *
 * Every failure mode short of a successful replace+reexec returns `fallback`
 * (when `opts.allowVersionSkew`) or throws (otherwise) — callers that don't
 * want the throw-based abort pass `allowVersionSkew: true` and print the
 * returned warning themselves. Nothing here touches the stack; a thrown
 * error is safe to surface before `performUpgrade` runs.
 */
export async function ensureCliCurrent(
  opts: { allowVersionSkew?: boolean; noSelfUpdate?: boolean; cliVersion?: string } = {},
  deps: Partial<EnsureCliCurrentDeps> = {},
): Promise<EnsureCliCurrentResult> {
  if (opts.noSelfUpdate) return { action: 'skip' };

  const d: EnsureCliCurrentDeps = { ...defaultEnsureCliCurrentDeps, ...deps };
  const cliVersion = opts.cliVersion ?? cliPkg.version;

  // A dev/unstamped CLI version (not comparable semver) can never be judged
  // "older" — skip the network round-trip entirely rather than resolve a tag
  // only to find the comparison was always going to be a no-op.
  if (!isComparableSemver(cliVersion)) return { action: 'current' };

  const abortOrFallback = (reason: string): EnsureCliCurrentResult => {
    if (opts.allowVersionSkew) return { action: 'fallback', reason };
    throw new CliCurrencyError(
      `${reason} Pass --no-self-update to run \`openpalm update\` with this CLI as-is, ` +
        'or --allow-version-skew to proceed anyway despite the failed check.',
    );
  };

  const tag = await d.resolveLatestTag().catch(() => null);
  if (!tag) return abortOrFallback('Unable to resolve the latest OpenPalm release to check this CLI against.');

  const skew = detectCliVersionSkew(cliVersion, tag);
  if (!skew.older) return { action: 'current' };

  if (d.platform === 'win32') {
    return abortOrFallback(
      'Self-update is not supported on Windows because a running executable cannot be replaced reliably. ' +
        'Run setup.ps1 --cli-only to refresh the CLI binary first.',
    );
  }
  if (!d.canReplace(d.execPath)) {
    return abortOrFallback(
      `${d.execPath} is not a standalone OpenPalm binary (a bun-run checkout). Reinstall with setup.sh --cli-only first.`,
    );
  }
  const execDir = dirname(d.execPath);
  if (!d.canWriteDir(execDir)) {
    return abortOrFallback(`Cannot write to ${execDir} to replace the CLI binary. Reinstall with setup.sh --cli-only, or fix permissions on that directory.`);
  }

  console.log(`This CLI is ${cliVersion}; updating it to ${tag} before upgrading the stack...`);
  let tempBinary: string;
  try {
    tempBinary = await d.downloadBinary(tag);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return abortOrFallback(`Failed to download the ${tag} CLI release: ${message}`);
  }

  try {
    d.replaceExecutable(tempBinary, d.execPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return abortOrFallback(`Failed to replace the CLI binary at ${d.execPath}: ${message}`);
  }

  // The replaced binary is the verified `tag` build, so its own phase 1 has
  // nothing left to do: re-run the original command with it skipped, which
  // also rules out a self-update loop by construction.
  const argv = process.argv.slice(2);
  const exitCode = d.reexec(argv.includes('--no-self-update') ? argv : [...argv, '--no-self-update']);
  return { action: 'reexec', exitCode };
}

export async function runUpgradeAction(
  opts: { allowVersionSkew?: boolean; noSelfUpdate?: boolean } = {},
): Promise<void> {
  const state = resolveUpgradeState();

  const cliResult = await ensureCliCurrent({
    allowVersionSkew: !!opts.allowVersionSkew,
    noSelfUpdate: !!opts.noSelfUpdate,
  });
  if (cliResult.action === 'reexec') {
    process.exit(cliResult.exitCode);
  }
  // Only a knowingly-proceeded-anyway older CLI ('fallback') still warrants
  // the self-update hint at the end — an unguarded run ('skip'/'current') is
  // already on the CLI it is about to deploy, so there is nothing to hint at.
  const stillOlderCli = cliResult.action === 'fallback';
  if (stillOlderCli) {
    console.warn(`Warning: ${cliResult.reason} Proceeding with the current (older) CLI.`);
  }

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
  // #679: say what is now running. "Update complete." with no versions is how
  // an update that silently advanced NOTHING passed for a successful one on a
  // live stack, release after release.
  const deployed = readVersions(state);
  console.log(
    `Images: ${SERVICE_VERSION_KEYS.map((key) => `${key.slice('OP_'.length).replace('_VERSION', '').toLowerCase()} ${deployed[key]}`).join(', ')}`,
  );
  console.log(stillOlderCli ? 'Update complete. To update the CLI itself, install a newer openpalm binary.' : 'Update complete.');
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
