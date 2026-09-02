import { defineCommand } from 'citty';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeWithPreflight } from '../lib/cli-compose.ts';
import {
  acquireInstallLock,
  createLogger,
  reapAndLogRetiredVolumes,
  releaseInstallLock,
  resolveDataDir,
  resolveBackupsDirFor,
  teardownRenamedProject,
  OP_HOME_TREES,
} from '@openpalm/lib';
import { defineAction } from '../lib/action.ts';

const logger = createLogger('cli:uninstall');

export default defineCommand({
  meta: {
    name: 'uninstall',
    description: 'Stop and remove the OpenPalm stack (preserves config and data)',
  },
  args: {
    volumes: {
      type: 'boolean',
      description: 'Also remove Docker volumes',
      default: false,
    },
    purge: {
      type: 'boolean',
      description: 'Remove all OpenPalm directories (config, data, knowledge, workspace)',
      default: false,
    },
  },
  run: defineAction(async ({ args }) => {
    await runUninstallAction({ volumes: !!args.volumes, purge: !!args.purge });
  }),
});

export async function runUninstallAction(
  args: { volumes?: boolean; purge?: boolean } = {},
): Promise<void> {
  const state = ensureValidState();
  const lock = acquireInstallLock(state.dataDir);
  if (!lock) throw new Error('install_in_progress: Another lifecycle operation is already running.');
  let purgeRemovedLock = false;
  try {
    const renameTeardown = await teardownRenamedProject(state);
    if (renameTeardown.blocked) {
      throw new Error(renameTeardown.warning ?? 'The previous OpenPalm project could not be stopped.');
    }
    const downArgs = args.volumes || args.purge ? ['down', '-v'] : ['down'];
    await runComposeWithPreflight(state, downArgs, lock);

    if (args.volumes || args.purge) {
      // `down -v` only removes volumes the compose files still DECLARE — on a
      // pre-#585 home the retired volumes' declarations are already gone (or
      // about to be, on --purge), so this is the one lifecycle path (besides
      // install/upgrade) that can strand them with no remaining reclamation
      // route. Runs before --purge's own directory removal below; harmless
      // either order since the reaper only ever touches Docker volumes, never
      // OP_HOME paths.
      await reapAndLogRetiredVolumes(state.homeDir, logger);
    }

    if (args.purge) {
      // #656 / lesson 24: the purge allowlist is DERIVED from the one tree
      // manifest (OP_HOME_TREES, home.ts) instead of an independent
      // hand-maintained list — purge missing a whole tree at introduction
      // (docs G7, the retired `private/` incident below) is exactly the class
      // of bug a manifest-derived list closes. C1: state/ and system/ must be
      // purged too — otherwise a survivor state/stack.env (OP_SETUP_COMPLETE)
      // or system/stack/core.compose.yml trips classifyLocalInstall and
      // blocks the next plain `install`, contradicting the purge's own "all
      // data removed" message. §G1: state/ also holds the delegated secrets
      // (UI login password, guardian/API tokens, portal principals, bot
      // credentials) that were moved OUT of the agent-reachable knowledge/
      // tree, under state/secrets/ and state/env/ — knowledge/ does not reach
      // them, which is what keeps `--purge`'s "all data removed" message true
      // instead of leaving every live credential on disk (Codex #5).
      // dataDir owns the lifecycle lock, so it is removed LAST, only after
      // every other destructive purge step has completed — every other tree
      // holds no lock or in-use handle so it is safe to go first.
      const purgeTreeDirs = OP_HOME_TREES.filter((tree) => tree.inPurge && tree.name !== 'data').map((tree) =>
        join(state.homeDir, tree.name),
      );
      const dirs = [
        ...purgeTreeDirs,
        // The retired `private/` tree, named literally because no manifest
        // entry reaches it anymore — it predates this layout. migrateOpHomeLayout
        // leaves it in place when the old and new copies of a credential
        // disagree, or when it holds anything the relocation does not move (a
        // subdirectory, a symlink, an operator's own file) — and in those
        // states it still holds live credentials. Drop this once the
        // supported upgrade floor passes schema 10, the same lifetime rule
        // the MIGRATIONS entries follow.
        join(state.homeDir, 'private'),
        resolveDataDir(),
      ];
      // A backup destination configured OUTSIDE OP_HOME (OP_BACKUP_DIR) is not
      // reached by any resolver above, so purge cannot claim "all data removed"
      // without saying so. Never delete it: it is an operator-chosen location
      // that may hold more than OpenPalm's snapshots.
      const backupsDir = resolveBackupsDirFor(state.homeDir);
      const externalBackups = !backupsDir.startsWith(`${state.homeDir}/`) && existsSync(backupsDir);

      for (const dir of dirs) {
        console.log(`Removing ${dir}`);
        rmSync(dir, { recursive: true, force: true });
        if (dir === state.dataDir) purgeRemovedLock = true;
      }
      if (externalBackups) {
        console.log(`OpenPalm stack and all data under ${state.homeDir} removed.`);
        console.log(`Backups at ${backupsDir} were preserved — remove them manually if you want them gone.`);
      } else {
        console.log('OpenPalm stack and all data removed.');
      }
    } else {
      console.log('OpenPalm stack stopped and removed.');
      if (!args.volumes) {
        console.log('Config and data directories are preserved. Use --purge to remove everything.');
      }
    }
  } finally {
    if (!purgeRemovedLock) releaseInstallLock(lock);
  }
}
