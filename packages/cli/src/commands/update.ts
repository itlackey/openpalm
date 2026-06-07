import { defineCommand } from 'citty';
import { performUpgrade, checkAndUpdateUiBuild, ensureMigrated, MigrationError } from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';

export default defineCommand({
  meta: {
    name: 'update',
    description: 'Refresh stack assets, pull latest images, and recreate containers',
  },
  async run() {
    try {
      await runUpgradeAction();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

export async function runUpgradeAction(): Promise<void> {
  // Auto-migrate the on-disk layout BEFORE validating state — createState()
  // assumes the current layout, so a 0.10.x home must be migrated first. This
  // backs up first and fails safe (no-ops on an already-current install).
  try {
    const report = ensureMigrated({ log: (m) => console.log(`  ${m}`) });
    if (report.migrated) {
      console.log(`Migrated layout ${report.from} → ${report.to} (backup: ${report.backupDir}).`);
      for (const note of report.notes) console.log(`  NOTE: ${note}`);
    }
  } catch (err) {
    if (err instanceof MigrationError) {
      console.error(`\nAutomatic migration aborted: ${err.message}\n${err.guidance}`);
      if (err.backupDir) console.error(`Backup: ${err.backupDir}`);
      process.exit(1);
    }
    throw err;
  }

  const state = ensureValidState();

  console.log('Upgrading stack...');
  const result = await performUpgrade(state);
  console.log(`Image tag: ${result.namespace}/*:${result.imageTag}`);
  if (result.assetsUpdated.length > 0) {
    console.log(`Assets updated: ${result.assetsUpdated.join(', ')}`);
  }

  // Check for a newer UI build on GitHub and install it if available.
  // Passes the pre-upgrade image tag as the reference version so any newer
  // release (including the one just upgraded to) triggers a download.
  // Existing data/ui/ is backed up to data/backups/ui-{timestamp}/ before
  // replacement. Non-fatal — existing build remains on any error.
  const currentVersion = state.imageTag ?? '0.0.0';
  console.log('Checking for UI build update...');
  const uiResult = await checkAndUpdateUiBuild(currentVersion, state.dataDir);
  if (uiResult.updated) {
    console.log(`UI build updated to v${uiResult.latestVersion}.`);
  } else if (uiResult.error) {
    console.warn(`Warning: UI build update skipped — ${uiResult.error}. Existing build still active.`);
  } else {
    console.log(`UI build is current (v${uiResult.latestVersion}).`);
  }

  console.log('Update complete.');
}
