/**
 * Runtime asset seeding and resolution for the UI build and OP_HOME skeleton.
 *
 * These functions are consumed by both the CLI and the Electron shell — they
 * must use only Node.js-compatible APIs (no Bun.spawn, Bun.write, etc.).
 *
 * Source resolution order (same for UI build and .openpalm/):
 *   1. OPENPALM_REPO_ROOT env var — explicit dev override
 *   2. Relative to import.meta.url — works for `bun run` / source installs
 *   3. Relative to process.execPath — works for compiled Bun binary in repo
 *   4. null → GitHub release download
 */
import {
  existsSync, mkdirSync, readdirSync, copyFileSync,
  writeFileSync, rmSync, realpathSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveStateDir } from './home.js';
import { createLogger } from '../logger.js';

const logger = createLogger('lib:ui-assets');

const REPO_OWNER = 'itlackey';
const REPO_NAME  = 'openpalm';

// ── Private helpers ──────────────────────────────────────────────────────────

async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.ok || res.status < 500) return res;
      if (i < retries - 1) await new Promise(r => setTimeout(r, 200 * 2 ** i));
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 200 * 2 ** i));
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries} attempts`);
}

function copyTree(
  src: string,
  dest: string,
  opts?: { skipExisting?: boolean },
): void {
  if (!existsSync(src)) return;
  const entries = readdirSync(src, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parentDir = (entry as unknown as { parentPath?: string; path?: string }).parentPath
      ?? (entry as unknown as { path: string }).path;
    const srcFile  = join(parentDir, entry.name);
    const rel      = relative(src, srcFile);
    const destFile = join(dest, rel);
    if (opts?.skipExisting && existsSync(destFile)) continue;
    mkdirSync(dirname(destFile), { recursive: true });
    copyFileSync(srcFile, destFile);
  }
}

/** Resolve a candidate path using three strategies, returning the first that exists. */
function resolveLocalCandidate(
  ...strategies: Array<() => string | null>
): string | null {
  for (const strategy of strategies) {
    try {
      const p = strategy();
      if (p && existsSync(p)) return p;
    } catch { /* skip */ }
  }
  return null;
}

// ── .openpalm/ skeleton ──────────────────────────────────────────────────────

/**
 * Locate the repo's .openpalm/ skeleton directory.
 * Used by seedOpenPalmDir to avoid a network download when running from source.
 */
export function resolveLocalOpenpalmDir(): string | null {
  return resolveLocalCandidate(
    // 1. Explicit dev override
    () => process.env.OPENPALM_REPO_ROOT
      ? join(process.env.OPENPALM_REPO_ROOT, '.openpalm')
      : null,
    // 2. Relative to this source file (dev / bun run)
    () => {
      const meta = fileURLToPath(import.meta.url);
      if (meta.startsWith('/$bunfs/')) return null;
      return join(dirname(meta), '..', '..', '..', '..', '.openpalm');
    },
    // 3. Relative to the compiled binary on disk
    () => join(dirname(realpathSync(process.execPath)), '..', '..', '..', '.openpalm'),
  );
}

/**
 * Seed OP_HOME from the .openpalm/ skeleton.
 *
 * Existing files are never overwritten (user edits win).
 * Falls back to downloading the repo tarball from GitHub when no local
 * skeleton is found (production binary, packaged Electron app).
 */
export async function seedOpenPalmDir(
  repoRef: string,
  homeDir: string,
  _configDir: string,
  _stateDir: string,
): Promise<void> {
  const local = resolveLocalOpenpalmDir();
  if (local) {
    logger.debug('seeding .openpalm from local source', { src: local });
    copyTree(local, homeDir, { skipExisting: true });
    return;
  }

  const tarballUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/${repoRef}.tar.gz`;
  logger.debug('downloading .openpalm skeleton', { url: tarballUrl });

  const tmpDir = join(homeDir, '.seed-tmp');
  const tmpTar = join(tmpDir, 'repo.tar.gz');
  mkdirSync(tmpDir, { recursive: true });

  try {
    const res = await fetchWithRetry(tarballUrl);
    if (!res.ok) throw new Error(`Failed to download tarball (HTTP ${res.status})`);
    writeFileSync(tmpTar, new Uint8Array(await res.arrayBuffer()));

    const result = spawnSync(
      'tar', ['xzf', tmpTar, '--strip-components=1'],
      { cwd: tmpDir },
    );
    if (result.status !== 0) throw new Error('tar extraction failed');

    const srcOpenpalm = join(tmpDir, '.openpalm');
    if (!existsSync(srcOpenpalm)) throw new Error('.openpalm/ not found in tarball');
    copyTree(srcOpenpalm, homeDir, { skipExisting: true });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── UI build ─────────────────────────────────────────────────────────────────

/**
 * Locate the compiled SvelteKit UI build on disk.
 * Returns null when not found — triggers GitHub download in seedUiBuild.
 */
export function resolveLocalUiBuild(): string | null {
  return resolveLocalCandidate(
    // 1. Explicit dev override
    () => process.env.OPENPALM_REPO_ROOT
      ? join(process.env.OPENPALM_REPO_ROOT, 'packages', 'ui', 'build')
      : null,
    // 2. Relative to this source file (dev / bun run)
    () => {
      const meta = fileURLToPath(import.meta.url);
      if (meta.startsWith('/$bunfs/')) return null;
      // lib source: packages/lib/src/control-plane/ui-assets.ts → 5 levels up
      const candidate = join(dirname(meta), '..', '..', '..', '..', 'packages', 'ui', 'build');
      return existsSync(join(candidate, 'index.js')) ? candidate : null;
    },
    // 3. Relative to compiled binary / Electron executable
    () => {
      const binDir = dirname(realpathSync(process.execPath));
      const candidate = join(binDir, '..', '..', '..', 'packages', 'ui', 'build');
      return existsSync(join(candidate, 'index.js')) ? candidate : null;
    },
  );
}

/**
 * Resolve the best available UI build directory at runtime.
 *
 * Priority:
 *   1. OP_HOME/state/ui/ — installed by seedUiBuild (production)
 *   2. Local packages/ui/build/ — dev / source install fallback
 */
export function resolveUiBuildDir(): string {
  const stateBuild = join(resolveStateDir(), 'ui');
  if (existsSync(join(stateBuild, 'index.js'))) return stateBuild;
  return resolveLocalUiBuild() ?? stateBuild; // fall back even if missing (error surfaces later)
}

/**
 * Install the UI build to OP_HOME/state/ui/.
 *
 * Copies from local packages/ui/build/ when running from source,
 * otherwise downloads ui-build.tar.gz from the GitHub release.
 * Called during install and update; always replaces existing content.
 *
 * state/ui/ is automatically included in backups because
 * backupOpenPalmHome() copies all of OP_HOME/state/.
 */
export async function seedUiBuild(repoRef: string, stateDir: string): Promise<void> {
  const uiDir = join(stateDir, 'ui');
  mkdirSync(uiDir, { recursive: true });

  const local = resolveLocalUiBuild();
  if (local) {
    logger.debug('seeding UI build from local source', { src: local });
    copyTree(local, uiDir);
    return;
  }

  const tarballUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${repoRef}/ui-build.tar.gz`;
  logger.debug('downloading UI build', { url: tarballUrl });

  const tmpTar = join(stateDir, '.ui-build.tar.gz.tmp');
  try {
    const res = await fetchWithRetry(tarballUrl);
    if (!res.ok) throw new Error(`Failed to download UI build (HTTP ${res.status})`);
    writeFileSync(tmpTar, new Uint8Array(await res.arrayBuffer()));

    const result = spawnSync('tar', ['xzf', tmpTar, '--strip-components=1', '-C', uiDir]);
    if (result.status !== 0) throw new Error(`UI build extraction failed (exit ${result.status})`);
  } finally {
    rmSync(tmpTar, { force: true });
  }
}
