import { defineCommand } from 'citty';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { defaultConfigHome, defaultStateHome } from '../lib/paths.ts';
import { ensureVarlock, prepareVarlockDir } from '../lib/varlock.ts';

export default defineCommand({
  meta: {
    name: 'scan',
    description: 'Scan codebase for leaked secrets (requires local secrets.env)',
  },
  async run() {
    const stateHome = defaultStateHome();
    const configHome = defaultConfigHome();

    const schemaPath = join(stateHome, 'artifacts', 'secrets.env.schema');
    const envPath = join(configHome, 'secrets.env');

    if (!(await Bun.file(schemaPath).exists())) {
      console.error(
        `Error: secrets.env.schema not found at ${schemaPath}.\nRun 'openpalm install' first to stage schema files.`,
      );
      process.exit(1);
    }

    if (!(await Bun.file(envPath).exists())) {
      console.error(
        `Error: secrets.env not found at ${envPath}.\nRun 'openpalm install' first.`,
      );
      process.exit(1);
    }

    const varlockBin = await ensureVarlock(stateHome);

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
