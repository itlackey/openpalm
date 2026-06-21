import { defineCommand } from 'citty';
import {
  ensureMigrated,
  ensureReleaseMigrated,
  PLATFORM_VERSION,
  formatForDisplay,
  MigrationError,
} from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';

export default defineCommand({
  meta: {
    name: 'migrate',
    description: 'Back up and migrate the OpenPalm home to the current on-disk layout',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Show what would change without writing anything',
      default: false,
    },
    to: {
      type: 'string',
      description:
        'Preview the release migrations an upgrade to <version> would run (defaults to the running control-plane version). Requires --dry-run.',
    },
  },
  async run({ args }) {
    const dryRun = Boolean(args['dry-run']);
    const toArg = typeof args.to === 'string' ? args.to.trim() : '';
    const hasTo = toArg.length > 0 || 'to' in args;

    // #497: `--to <version>` previews the RELEASE migrations an upgrade WOULD
    // run, read from the target version rather than the current stack.env. This
    // is a preview only — actually applying forward release migrations against a
    // not-yet-upgraded stack is `openpalm update`'s job, so require --dry-run.
    if (hasTo) {
      if (!dryRun) {
        console.error('`--to` previews an upgrade and only runs with --dry-run. To apply an upgrade, run `openpalm update`.');
        process.exit(1);
      }
      try {
        const state = ensureValidState();
        // Default the preview target to the running control plane's own version —
        // image versions are now user-managed in stack.env (no remote registry
        // lookup), and `openpalm update` runs migrations for PLATFORM_VERSION.
        const targetVersion = toArg || PLATFORM_VERSION;
        console.log(`\n[dry-run] Release migrations that an upgrade to ${formatForDisplay(targetVersion)} would run:`);
        const report = ensureReleaseMigrated({
          homeDir: state.homeDir,
          targetVersion,
          dryRun: true,
          log: (m) => console.log(`  ${m}`),
        });
        if (report.applied.length === 0) {
          console.log(`  (none — your files are already compatible with ${formatForDisplay(report.to)}.)`);
        } else {
          console.log(`\n[dry-run] Would apply ${report.applied.length} release migration(s): ${report.applied.join(', ')}. No changes written.`);
        }
        for (const note of report.notes) console.log(`  NOTE: ${note}`);
        console.log('\nTo apply, run `openpalm update`.');
        return;
      } catch (err) {
        if (err instanceof MigrationError) {
          console.error(`\nMigration preview failed: ${err.message}\n${err.guidance}`);
          process.exit(1);
        }
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }

    try {
      const report = ensureMigrated({ dryRun, log: (m) => console.log(`  ${m}`) });
      if (!report.migrated && report.from >= report.to) {
        console.log(`Already on the current layout (version ${report.to}). Nothing to do.`);
        return;
      }
      if (dryRun) {
        console.log(`\n[dry-run] Would migrate layout ${report.from} → ${report.to}. No changes written.`);
        return;
      }
      console.log(`\nMigrated layout ${report.from} → ${report.to}.`);
      if (report.backupDir) console.log(`Backup: ${report.backupDir}`);
      for (const note of report.notes) console.log(`NOTE: ${note}`);
      console.log('\nNext: run `openpalm update` to pull the new images and recreate containers.');
    } catch (err) {
      if (err instanceof MigrationError) {
        console.error(`\nMigration aborted: ${err.message}\n${err.guidance}`);
        if (err.backupDir) {
          console.error(`If something went wrong, your previous state is backed up at ${err.backupDir} — run \`openpalm rollback\`.`);
        }
        process.exit(1);
      }
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
