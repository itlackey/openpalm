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
  writeFileSync, rmSync, realpathSync, renameSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { x as tarExtract } from 'tar';
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
    // Registry is system-managed — always refresh so addon overlays stay current.
    copyTree(join(local, 'state', 'registry'), join(homeDir, 'state', 'registry'));
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

    await tarExtract({ file: tmpTar, cwd: tmpDir, strip: 1 });

    const srcOpenpalm = join(tmpDir, '.openpalm');
    if (!existsSync(srcOpenpalm)) throw new Error('.openpalm/ not found in tarball');
    copyTree(srcOpenpalm, homeDir, { skipExisting: true });
    // Registry is system-managed — always refresh so addon overlays stay current.
    copyTree(join(srcOpenpalm, 'state', 'registry'), join(homeDir, 'state', 'registry'));
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
    // 2. Electron extraResources — ui-build/ is placed alongside the asar
    () => {
      const rp = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
      if (!rp) return null;
      return join(rp, 'ui-build');
    },
    // 3. Relative to this source file (dev / bun run)
    () => {
      const meta = fileURLToPath(import.meta.url);
      if (meta.startsWith('/$bunfs/')) return null;
      // lib source: packages/lib/src/control-plane/ui-assets.ts → 5 levels up
      const candidate = join(dirname(meta), '..', '..', '..', '..', 'packages', 'ui', 'build');
      return existsSync(join(candidate, 'index.js')) ? candidate : null;
    },
    // 4. Relative to compiled binary / Electron executable
    () => {
      const binDir = dirname(realpathSync(process.execPath));
      const candidate = join(binDir, '..', '..', '..', 'packages', 'ui', 'build');
      return existsSync(join(candidate, 'index.js')) ? candidate : null;
    },
  );
}

function readUiVersionFile(dir: string): string | null {
  try { return readFileSync(join(dir, 'version.txt'), 'utf-8').trim(); } catch { return null; }
}

/**
 * Resolve the best available UI build directory at runtime.
 *
 * Priority:
 *   1. OP_HOME/state/ui/ — if its version.txt is NEWER than the bundled build
 *   2. Bundled / local build (Electron extraResources, source checkout)
 *   3. OP_HOME/state/ui/ — fallback when no bundled build exists
 *
 * This means GitHub-downloaded updates are applied automatically (disk wins
 * when newer), but a fresh AppImage install always works without a download.
 */
export function resolveUiBuildDir(): string {
  const stateBuild = join(resolveStateDir(), 'ui');
  const localBuild = resolveLocalUiBuild();

  if (existsSync(join(stateBuild, 'index.js')) && localBuild) {
    const diskVer    = readUiVersionFile(stateBuild);
    const bundledVer = readUiVersionFile(localBuild);
    if (diskVer && bundledVer && compareVersionTags(diskVer, bundledVer) > 0) {
      return stateBuild;
    }
    return localBuild;
  }

  if (localBuild) return localBuild;
  return stateBuild;
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
/** SHA-256 hex digest of arbitrary bytes. */
function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Parse a `sha256sum`-format checksums file into a filename→hash map.
 * Each line is: `<hash>  <filename>` (one or two spaces).
 */
function parseChecksumsFile(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.trim().split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      map.set(parts[parts.length - 1], parts[0]);
    }
  }
  return map;
}

export async function seedUiBuild(repoRef: string, stateDir: string): Promise<void> {
  const uiDir = join(stateDir, 'ui');
  mkdirSync(uiDir, { recursive: true });

  const local = resolveLocalUiBuild();
  if (local) {
    logger.debug('seeding UI build from local source', { src: local });
    copyTree(local, uiDir);
    writeFileSync(join(uiDir, 'version.txt'), repoRef.replace(/^v/, ''));
    return;
  }

  const base         = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${repoRef}`;
  const tarballUrl   = `${base}/ui-build.tar.gz`;
  const checksumUrl  = `${base}/checksums-sha256.txt`;
  logger.debug('downloading UI build', { url: tarballUrl });

  const tmpTar = join(stateDir, '.ui-build.tar.gz.tmp');
  try {
    // Download tarball and checksums file in parallel (checksums best-effort)
    const [tarRes, csRes] = await Promise.all([
      fetchWithRetry(tarballUrl),
      fetchWithRetry(checksumUrl).catch(() => null),
    ]);
    if (!tarRes.ok) throw new Error(`Failed to download UI build (HTTP ${tarRes.status})`);

    const tarData = new Uint8Array(await tarRes.arrayBuffer());

    // Verify SHA-256 if the checksums file was available
    if (csRes?.ok) {
      const checksums = parseChecksumsFile(await csRes.text());
      const expected  = checksums.get('ui-build.tar.gz');
      if (expected) {
        const actual = sha256Hex(tarData);
        if (actual !== expected) {
          throw new Error(`UI build checksum mismatch (expected ${expected}, got ${actual})`);
        }
        logger.debug('UI build checksum verified', { sha256: actual });
      }
    }

    writeFileSync(tmpTar, tarData);

    // Cross-platform extraction via the `tar` npm package — no shell dependency
    await tarExtract({ file: tmpTar, cwd: uiDir, strip: 1 });
    writeFileSync(join(uiDir, 'version.txt'), repoRef.replace(/^v/, ''));
  } finally {
    rmSync(tmpTar, { force: true });
  }
}

// ── UI update check ──────────────────────────────────────────────────────────

const GITHUB_API = 'https://api.github.com';

/** Returns 1 if a > b, -1 if a < b, 0 if equal. Strips leading 'v'. */
function compareVersionTags(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [aM, am, ap] = parse(a);
  const [bM, bm, bp] = parse(b);
  if (aM !== bM) return aM > bM ? 1 : -1;
  if (am !== bm) return am > bm ? 1 : -1;
  if (ap !== bp) return ap > bp ? 1 : -1;
  return 0;
}

export interface UiBuildUpdateResult {
  updated: boolean;
  latestVersion: string | null;
  error?: string;
}

/**
 * Check GitHub for a newer UI build and apply it if one exists.
 *
 * When an update is available:
 *   1. Move state/ui/ → state/backups/ui-{timestamp}/ (preserves the old build)
 *   2. Download ui-build.tar.gz from the latest release and extract to state/ui/
 *
 * Non-fatal: any network or extraction error returns { updated: false, error }.
 * The caller should proceed with the existing build on failure.
 */
export async function checkAndUpdateUiBuild(
  currentVersion: string,
  stateDir: string,
): Promise<UiBuildUpdateResult> {
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      {
        headers: { 'User-Agent': `OpenPalm/${currentVersion}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      return { updated: false, latestVersion: null, error: `GitHub API returned ${res.status}` };
    }

    const release = await res.json() as {
      tag_name: string;
      assets: Array<{ name: string }>;
    };
    const latestTag     = release.tag_name;           // e.g. "v0.11.0"
    const latestVersion = latestTag.replace(/^v/, '');

    if (compareVersionTags(latestTag, currentVersion) <= 0) {
      logger.debug('UI build is up to date', { current: currentVersion, latest: latestVersion });
      return { updated: false, latestVersion };
    }

    if (!release.assets.some(a => a.name === 'ui-build.tar.gz')) {
      return { updated: false, latestVersion, error: 'Latest release has no ui-build.tar.gz' };
    }

    // Back up the existing UI build before replacing it
    const uiDir = join(stateDir, 'ui');
    if (existsSync(join(uiDir, 'index.js'))) {
      const backupDir = join(stateDir, 'backups', `ui-${Date.now()}`);
      mkdirSync(join(stateDir, 'backups'), { recursive: true });
      renameSync(uiDir, backupDir);
      logger.debug('backed up UI build before update', { backup: backupDir });
    }

    await seedUiBuild(latestTag, stateDir);
    logger.debug('UI build updated', { from: currentVersion, to: latestVersion });

    return { updated: true, latestVersion };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.debug('UI build update check failed (non-fatal)', { error });
    return { updated: false, latestVersion: null, error };
  }
}
