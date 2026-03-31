import { defineCommand } from 'citty';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { resolveVaultDir } from '@openpalm/lib';
import { ensureVarlock, prepareVarlockDir } from '../lib/varlock.ts';

export default defineCommand({
  meta: {
    name: 'scan',
    description: 'Scan codebase for leaked secrets (requires local user.env)',
  },
  async run() {
    const vaultDir = resolveVaultDir();

    const schemaPath = join(vaultDir, 'user', 'user.env.schema');
    const envPath = join(vaultDir, 'user', 'user.env');

    if (!(await Bun.file(schemaPath).exists())) {
      console.error(
        `Error: vault/user/user.env.schema not found at ${schemaPath}.\nRun 'openpalm install' first.`,
      );
      process.exit(1);
    }

    if (!(await Bun.file(envPath).exists())) {
      console.error(
        `Error: user.env not found at ${envPath}.\nRun 'openpalm install' first.`,
      );
      process.exit(1);
    }

    const varlockBin = await ensureVarlock();

    const tmpDir = await prepareVarlockDir(schemaPath, envPath);
    let exitCode = 1;
    try {
      const proc = Bun.spawn([varlockBin, 'scan', '--path', `${tmpDir}/`], {
        stdout: 'inherit',
        stderr: 'inherit',
      });
      exitCode = await proc.exited;
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
    process.exit(exitCode);
  },
});
