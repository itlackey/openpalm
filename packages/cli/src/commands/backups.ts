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
        description: 'Prune older backup snapshots while keeping the newest N',
      },
      args: {
        keep: {
          type: 'string',
          description: 'Number of newest backups to keep',
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
