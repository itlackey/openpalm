/**
 * Filesystem and HTTP helpers used by the CLI install/upgrade flows.
 *
 * Asset seeding (applyHomeSeed, seedUiBuild) and path resolution
 * (resolveLocalUiBuild, resolveUiBuildDir) now live in @openpalm/lib
 * so both the CLI and any future Electron shell can import them directly.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

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

/** Returns true if `path` is an existing directory. */
export function dirExists(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Recursively copy files from src to dest. */
export async function copyTree(
  src: string,
  dest: string,
  opts?: { skipExisting?: boolean; onlyPattern?: RegExp },
): Promise<void> {
  if (!dirExists(src)) return;
  const entries = readdirSync(src, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parentDir = (entry as unknown as { parentPath?: string; path?: string }).parentPath
      ?? (entry as unknown as { path: string }).path;
    const srcFile = join(parentDir, entry.name);
    const rel = relative(src, srcFile);
    if (opts?.onlyPattern && !opts.onlyPattern.test(rel)) continue;
    const destFile = join(dest, rel);
    if (opts?.skipExisting && existsSync(destFile)) continue;
    await mkdir(dirname(destFile), { recursive: true });
    await writeFile(destFile, new Uint8Array(await Bun.file(srcFile).arrayBuffer()));
  }
}

// Re-export from lib so existing imports in CLI commands keep working.
export { applyHomeSeed, seedUiBuild, seedClientBuild, uiUpdateChannel } from '@openpalm/lib';
