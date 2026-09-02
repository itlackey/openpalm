import { defineCommand } from 'citty';
import { planBackupPrune, pruneBackupDirs, resolveOpenPalmHome, summarizeBackups } from '@openpalm/lib';
import { promptYesNo } from '../lib/prompt.ts';

export default defineCommand({
  meta: {
    name: 'backups',
    description: 'List and prune upgrade backup snapshots',
  },
  subCommands: {
    list: defineCommand({
      meta: {
        name: 'list',
        description: 'List upgrade backup snapshots (newest first), with size and creation time.',
      },
      async run() {
        const homeDir = resolveOpenPalmHome();
        const summary = summarizeBackups(homeDir);

        if (summary.count === 0) {
          console.log('No backups found.');
          return;
        }

        for (const backup of summary.backups) {
          console.log(`${backup.name}  ${backup.sizeBytes} bytes  ${backup.createdAt}`);
        }
        console.log(`\n${summary.count} backup(s), ${summary.totalBytes} bytes total.`);
      },
    }),
    prune: defineCommand({
      meta: {
        name: 'prune',
        description: [
          'Prune older backup snapshots while keeping the newest N.',
          '',
          'Recommended retention policy (owner decision #3):',
          '  - Major upgrade (e.g. 0.x → 1.0.0): keep backups covering 1 major release back',
          '    plus all intermediate minor versions (e.g. upgrading to 1.0.0 → retain 0.13.x).',
          '  - Minor upgrade (e.g. 0.12.0 → 0.13.0): keep 1 prior minor (the most recent',
          '    backup from the previous minor series).',
          '',
          'This command is always confirm-gated; use --yes to skip the prompt. Other paths',
          'prune on their own: `install --force` keeps the newest 3, the host-side UI/skeleton',
          'updater keeps the newest 3 of its own `ui-*`/`skeleton-*` snapshots, and `openpalm',
          'rollback` keeps the newest 3 of its own `-pre-rollback` snapshots. A `-pre-update`',
          'recovery snapshot is never pruned by anything, by any path, regardless of --keep.',
        ].join('\n'),
      },
      args: {
        keep: {
          type: 'string',
          description: [
            'Number of newest backups to keep.',
            'Policy guidance: for a minor upgrade, --keep 2 retains the pre-upgrade snapshot',
            'plus one prior; for a major upgrade, set N to cover all intermediate minors.',
          ].join(' '),
          required: true,
        },
        yes: {
          type: 'boolean',
          alias: 'y',
          description: 'Skip confirmation prompt',
          default: false,
        },
      },
      async run({ args }) {
        const keep = Number(args.keep);
        if (!Number.isInteger(keep) || keep < 0) {
          console.error('--keep must be a non-negative integer');
          process.exit(1);
        }

        const homeDir = resolveOpenPalmHome();
        // Preview exactly what pruneBackupDirs will delete. A global
        // `listBackupDirs().slice(keep)` disagrees with it in both directions:
        // retention is per-namespace, and a -pre-update snapshot is never
        // pruned — so the old preview could list dirs that survive and omit
        // dirs that die, on a destructive confirm prompt.
        const { toDelete, protected: protectedDirs } = planBackupPrune(homeDir, keep);

        if (toDelete.length === 0) {
          console.log('No backups to prune.');
          return;
        }

        console.log('The following backup directories will be deleted:');
        for (const backupDir of toDelete) console.log(`  ${backupDir}`);
        if (protectedDirs.length > 0) {
          console.log('\nThese recovery snapshots are protected and will be kept:');
          for (const backupDir of protectedDirs) console.log(`  ${backupDir}`);
        }

        if (!args.yes) {
          const ok = await promptYesNo('Delete these backups? [y/N]');
          if (!ok) {
            console.log('Prune aborted. Re-run with --yes to skip confirmation.');
            return;
          }
        }

        const deleted = pruneBackupDirs(homeDir, keep);
        console.log(JSON.stringify({ ok: true, deleted, kept: keep }, null, 2));
      },
    }),
  },
});
