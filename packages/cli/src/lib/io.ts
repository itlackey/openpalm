/**
 * Filesystem and HTTP helpers used by the CLI install/upgrade flows.
 *
 * Nothing here is Docker-specific: this module owns directory-tree
 * creation, asset fetching with retry, recursive tree copy, and a
 * synchronous directory existence check.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const REPO_OWNER = 'itlackey';
const REPO_NAME = 'openpalm';

/**
 * Creates the full directory tree required by the stack.
 * Uses the caller-provided directory roots, then adds CLI-specific extras.
 */
export async function ensureDirectoryTree(
  homeDir: string,
  _configDir: string,
  _vaultDir: string,
  _dataDir: string,
  workDir: string,
): Promise<void> {
  const configDir = `${homeDir}/config`;
  const stateDir = `${homeDir}/state`;
  const cacheDir = `${homeDir}/cache`;

  for (const dir of [
    homeDir,
    // config/ — user-editable config + system config
    configDir,
    join(configDir, 'automations'),
    join(configDir, 'assistant'),
    join(configDir, 'assistant', 'tools'),
    join(configDir, 'assistant', 'plugins'),
    join(configDir, 'assistant', 'skills'),
    join(configDir, 'akm'),
    // config/stack/ — compose runtime + stack config
    join(configDir, 'stack'),
    join(configDir, 'stack', 'addons'),
    // stash/ — akm asset content (skills, vaults, knowledge, agents)
    join(homeDir, 'stash'),
    // workspace/ — shared assistant workspace
    join(homeDir, 'workspace'),
    // cache/ — regenerable/semi-persistent data
    cacheDir,
    join(cacheDir, 'akm'),
    join(cacheDir, 'guardian'),
    join(cacheDir, 'rollback'),
    // state/ — persistent service data
    stateDir,
    join(stateDir, 'assistant'),
    join(stateDir, 'admin'),
    join(stateDir, 'guardian'),
    join(stateDir, 'guardian', 'stash'),
    join(stateDir, 'guardian', 'akm'),
    join(stateDir, 'guardian', 'akm', 'data'),
    join(stateDir, 'guardian', 'akm', 'state'),
    join(stateDir, 'akm'),
    join(stateDir, 'akm', 'data'),
    join(stateDir, 'akm', 'state'),
    join(stateDir, 'scheduler'),
    join(stateDir, 'scheduler', 'triggers'),
    join(stateDir, 'logs'),
    join(stateDir, 'logs', 'opencode'),
    join(stateDir, 'backups'),
    join(stateDir, 'registry'),
    join(stateDir, 'registry', 'addons'),
    join(stateDir, 'registry', 'automations'),
    workDir,
  ]) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Fetches a URL with retries and exponential backoff. Only retries on 5xx or network errors.
 */
async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (res.ok || res.status < 500) return res;
      if (i < retries - 1) await Bun.sleep(200 * 2 ** i);
    } catch (err) {
      if (i === retries - 1) throw err;
      await Bun.sleep(200 * 2 ** i);
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries} attempts`);
}

/**
 * Downloads an asset from a GitHub release, falling back to raw.githubusercontent.com.
 */
export async function fetchAsset(repoRef: string, filename: string): Promise<string> {
  const releaseUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${repoRef}/${filename}`;
  const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${repoRef}/${filename}`;

  try {
    const releaseResponse = await fetchWithRetry(releaseUrl);
    if (releaseResponse.ok) return await releaseResponse.text();
  } catch {
    // Fall through to raw URL
  }

  const rawResponse = await fetchWithRetry(rawUrl);
  if (rawResponse.ok) return await rawResponse.text();

  throw new Error(`Failed to download ${filename} from ${repoRef}`);
}

/**
 * Returns true if `path` is an existing directory; false otherwise.
 */
export function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursively copy every regular file from `src` to `dest`. Directories
 * are created as needed. Uses `node:fs` recursive readdir — no shell-out
 * to `find` (which has incompatible flags between BSD and GNU).
 *
 * Options:
 *  - `skipExisting`: don't overwrite files that already exist at dest
 *  - `onlyPattern`: only copy files whose path-relative-to-src matches
 */
export async function copyTree(
  src: string,
  dest: string,
  opts?: { skipExisting?: boolean; onlyPattern?: RegExp },
): Promise<void> {
  if (!dirExists(src)) return;

  const entries = readdirSync(src, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // entry.parentPath was added in Node 20; entry.path is the legacy alias.
    const parentDir = (entry as unknown as { parentPath?: string; path?: string }).parentPath
      ?? (entry as unknown as { path: string }).path;
    const srcFile = join(parentDir, entry.name);
    const rel = relative(src, srcFile);
    if (opts?.onlyPattern && !opts.onlyPattern.test(rel)) continue;
    const destFile = join(dest, rel);
    if (opts?.skipExisting && await Bun.file(destFile).exists()) continue;
    await mkdir(dirname(destFile), { recursive: true });
    const content = await Bun.file(srcFile).arrayBuffer();
    await writeFile(destFile, new Uint8Array(content));
  }
}

/**
 * Downloads the latest .openpalm/ assets from GitHub and seeds them into
 * the OP_HOME tree. Optional — embedded assets in lib provide the
 * baseline; this function upgrades to the latest release versions.
 */
export async function seedOpenPalmDir(
  repoRef: string,
  homeDir: string,
  _configDir: string,
  stateDir: string,
): Promise<void> {
  const tarballUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/${repoRef}.tar.gz`;
  const tmpDir = join(homeDir, '.seed-tmp');
  const tmpTar = join(tmpDir, 'repo.tar.gz');

  try {
    await mkdir(tmpDir, { recursive: true });

    const res = await fetch(tarballUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Failed to download tarball (HTTP ${res.status})`);
    await Bun.write(tmpTar, res);

    // Extract full tarball — avoid --wildcards which is GNU tar-only and
    // breaks on macOS (BSD tar), causing silent extraction failure.
    const extractProc = Bun.spawn(
      ['tar', 'xzf', tmpTar, '--strip-components=1'],
      { cwd: tmpDir, stdout: 'ignore', stderr: 'pipe' },
    );
    const extractCode = await extractProc.exited;
    if (extractCode !== 0) {
      throw new Error(`tar extraction failed (exit code ${extractCode})`);
    }

    const srcCoreCompose = join(tmpDir, '.openpalm', 'stack', 'core.compose.yml');
    if (!await Bun.file(srcCoreCompose).exists()) {
      throw new Error('core.compose.yml not found in downloaded assets');
    }
    await mkdir(join(homeDir, 'stack'), { recursive: true });
    await writeFile(
      join(homeDir, 'stack', 'core.compose.yml'),
      new Uint8Array(await Bun.file(srcCoreCompose).arrayBuffer()),
    );

    const srcRegistry = join(tmpDir, '.openpalm', 'registry');
    if (dirExists(srcRegistry)) {
      await copyTree(srcRegistry, join(stateDir, 'registry'));
    }

    const srcAssistant = join(tmpDir, 'core', 'assistant', 'opencode');
    if (dirExists(srcAssistant)) {
      await copyTree(srcAssistant, join(homeDir, 'services', 'assistant'));
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
