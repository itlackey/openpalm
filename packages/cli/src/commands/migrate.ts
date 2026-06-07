import { defineCommand } from 'citty';
import { ensureMigrated, MigrationError } from '@openpalm/lib';

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
  },
  async run({ args }) {
    const dryRun = Boolean(args['dry-run']);
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
        if (err.backupDir) console.error(`Backup: ${err.backupDir}`);
        process.exit(1);
      }
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
