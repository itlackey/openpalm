/**
 * Filesystem and HTTP helpers used by the CLI install/upgrade flows.
 *
 * Asset seeding (seedOpenPalmDir, seedUiBuild) and path resolution
 * (resolveLocalUiBuild, resolveUiBuildDir) now live in @openpalm/lib
 * so both the CLI and any future Electron shell can import them directly.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const REPO_OWNER = 'itlackey';
const REPO_NAME = 'openpalm';

/**
 * Creates the full directory tree required by the stack.
 */
export async function ensureDirectoryTree(
  homeDir: string,
  _configDir: string,
  _vaultDir: string,
  _dataDir: string,
  workDir: string,
): Promise<void> {
  const configDir = `${homeDir}/config`;
  const dataDir = `${homeDir}/data`;

  for (const dir of [
    homeDir,
    configDir,
    join(configDir, 'assistant'),
    join(configDir, 'assistant', 'tools'),
    join(configDir, 'assistant', 'plugins'),
    join(configDir, 'assistant', 'skills'),
    join(configDir, 'akm'),
    join(configDir, 'stack'),
    join(homeDir, 'knowledge'),
    join(homeDir, 'knowledge', 'env'),
    join(homeDir, 'knowledge', 'secrets'),
    join(homeDir, 'knowledge', 'tasks'),
    join(homeDir, 'workspace'),
    dataDir,
    join(dataDir, 'assistant'),
    join(dataDir, 'admin'),
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

async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (res.ok || res.status < 500) return res;
      if (i < retries - 1) await new Promise(r => setTimeout(r, 200 * 2 ** i));
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 200 * 2 ** i));
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries} attempts`);
}

/** Downloads a text asset from a GitHub release, falling back to raw URL. */
export async function fetchAsset(repoRef: string, filename: string): Promise<string> {
  const releaseUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${repoRef}/${filename}`;
  const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${repoRef}/${filename}`;

  try {
    const r = await fetchWithRetry(releaseUrl);
    if (r.ok) return await r.text();
  } catch { /* fall through */ }

  const r = await fetchWithRetry(rawUrl);
  if (r.ok) return await r.text();
  throw new Error(`Failed to download ${filename} from ${repoRef}`);
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
export { seedOpenPalmDir, seedUiBuild } from '@openpalm/lib';
