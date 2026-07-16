/**
 * Directory-tree setup for the CLI install flow. Asset seeding
 * (applyHomeSeed, seedUiBuild) and path resolution live in @openpalm/lib and
 * are imported from there directly.
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

