import { defineCommand } from 'citty';
import { listBackupDirs, pruneBackupDirs, resolveOpenPalmHome } from '@openpalm/lib';
import { createInterface } from 'node:readline';

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export default defineCommand({
  meta: {
    name: 'backups',
    description: 'List and prune upgrade backup snapshots',
  },
  subCommands: {
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
          'Pruning is never automatic and always confirm-gated. Use --yes to skip the prompt.',
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
        const existing = listBackupDirs(homeDir);
        const toDelete = existing.slice(keep);

        if (toDelete.length === 0) {
          console.log('No backups to prune.');
          return;
        }

        console.log('The following backup directories will be deleted:');
        for (const backupDir of toDelete) console.log(`  ${backupDir}`);

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
