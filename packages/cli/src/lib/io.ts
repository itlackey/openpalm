/**
 * Filesystem and HTTP helpers used by the CLI install/upgrade flows.
 *
 * Asset seeding (applyHomeSeed, seedUiBuild) and path resolution
 * (resolveLocalUiBuild, resolveUiBuildDir) now live in @openpalm/lib
 * so both the CLI and any future Electron shell can import them directly.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Creates the full directory tree required by the stack.
 */
export async function ensureDirectoryTree(
  homeDir: string,
  workDir: string,
): Promise<void> {
  const configDir = `${homeDir}/config`;
  const dataDir = `${homeDir}/data`;

  for (const dir of [
    homeDir,
    configDir,
    join(configDir, 'assistant'),
    join(configDir, 'akm'),
    join(configDir, 'stack'),
    join(homeDir, 'knowledge'),
    join(homeDir, 'knowledge', 'env'),
    join(homeDir, 'knowledge', 'secrets'),
    join(homeDir, 'knowledge', 'tasks'),
    join(homeDir, 'workspace'),
    dataDir,
    join(dataDir, 'assistant'),
    join(dataDir, 'guardian'),
    join(dataDir, 'akm', 'cache'),
    join(dataDir, 'akm', 'data'),
    join(dataDir, 'logs'),
    join(dataDir, 'backups'),
    join(dataDir, 'rollback'),
    join(dataDir, 'ui'),
    workDir,
  ]) {
    await mkdir(dir, { recursive: true });
  }
}

