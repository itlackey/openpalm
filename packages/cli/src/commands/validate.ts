import { defineCommand } from 'citty';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { defaultVaultDir, defaultDataDir } from '../lib/paths.ts';
import { ensureVarlock, prepareVarlockDir } from '../lib/varlock.ts';

export default defineCommand({
  meta: {
    name: 'validate',
    description: 'Validate configuration against schema',
  },
  async run() {
    const vaultDir = defaultVaultDir();
    const dataDir = defaultDataDir();

    const primarySchema = join(vaultDir, 'user.env.schema');
    const envPath = join(vaultDir, 'user', 'user.env');

    if (!(await Bun.file(primarySchema).exists())) {
      console.error(
        `Error: user.env.schema not found at ${primarySchema}.\nRun 'openpalm install' first.`,
      );
      process.exit(1);
    }

    if (!(await Bun.file(envPath).exists())) {
      console.error(
        `Error: user.env not found at ${envPath}.\nRun 'openpalm install' first.`,
      );
      process.exit(1);
    }

    const varlockBin = await ensureVarlock(dataDir);
    const tmpDir = await prepareVarlockDir(primarySchema, envPath);
    let exitCode = 1;
    try {
      const proc = Bun.spawn(
        [varlockBin, 'load', '--path', `${tmpDir}/`],
        { stdout: 'inherit', stderr: 'inherit' },
      );
      exitCode = await proc.exited;
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
    process.exit(exitCode);
  },
});
