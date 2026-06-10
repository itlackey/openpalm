/**
 * Runtime asset seeding and resolution for the UI build and OP_HOME skeleton.
 *
 * These functions are consumed by both the CLI and the Electron shell — they
 * must use only Node.js-compatible APIs (no Bun.spawn, Bun.write, etc.).
 *
 * Source resolution order (UI build and .openpalm/ skeleton):
 *   1. OPENPALM_REPO_ROOT env var — explicit dev override
 *   2. Relative to import.meta.url — works for `bun run` / source installs
 *   3. Relative to process.execPath — works for compiled Bun binary in repo
 *   4. null → remote download (the UI build from the @openpalm/ui npm registry
 *      tarball; the .openpalm skeleton from the GitHub repo tarball)
 */
import {
  existsSync, mkdirSync, readdirSync, copyFileSync,
  writeFileSync, readFileSync, rmSync, realpathSync, renameSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { x as tarExtract } from 'tar';
import { resolveBackupsDir, resolveDataDir } from './home.js';
import { createLogger } from '../logger.js';
import { compareComparableVersions, isSameMajorVersion } from './versioning.js';

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
    // 2. Electron extraResources — openpalm-skeleton/ placed alongside the asar
    () => process.env.OPENPALM_SKELETON_DIR ?? null,
    // 3. Relative to this source file (dev / bun run)
    () => {
      const meta = fileURLToPath(import.meta.url);
      if (meta.startsWith('/$bunfs/')) return null;
      return join(dirname(meta), '..', '..', '..', '..', '.openpalm');
    },
    // 4. Relative to the compiled binary on disk
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
/** Version stamp recording which skeleton version OP_HOME was last seeded from. */
export const SKELETON_VERSION_STAMP = '.skeleton-version';

/**
 * SYSTEM-managed stack assets (relative to OP_HOME) that must be REFRESHED to the
 * shipped version on every install — NOT seed-if-missing. An OP_HOME carried over
 * from an older version otherwise keeps deploying stale compose structure (#472).
 * These are system-owned per core-principles; user-owned files (custom.compose.yml,
 * config/, secrets, stack.env) are deliberately excluded and stay seed-if-missing.
 */
export const MANAGED_STACK_ASSETS = [
  'config/stack/core.compose.yml',
  'config/stack/services.compose.yml',
  'config/stack/channels.compose.yml',
] as const;

/** Overwrite the system-managed stack assets from `srcOpenpalm` into `homeDir`. */
export function refreshManagedStackAssets(srcOpenpalm: string, homeDir: string): string[] {
  const refreshed: string[] = [];
  for (const rel of MANAGED_STACK_ASSETS) {
    const src = join(srcOpenpalm, rel);
    if (!existsSync(src)) continue;
    const dest = join(homeDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    refreshed.push(rel);
  }
  return refreshed;
}

/**
 * Seed the bundled `.openpalm/` skeleton into OP_HOME — ONCE PER VERSION.
 *
 * Electron calls this on every launch; without a guard it re-copied the entire
 * skeleton tree each time (wasteful, and it re-materialized files a user/process
 * had deliberately removed). We stamp OP_HOME/.skeleton-version with `repoRef`
 * after a successful seed and skip the copy when it already matches — so a given
 * version seeds once and an upgrade re-seeds (skipExisting still preserves any
 * user edits). To force a re-seed, delete the stamp.
 */
export async function seedOpenPalmDir(
  repoRef: string,
  homeDir: string,
  _configDir: string,
  _dataDir: string,
): Promise<void> {
  const stampPath = join(homeDir, SKELETON_VERSION_STAMP);
  let alreadySeeded = false;
  if (existsSync(stampPath)) {
    try {
      alreadySeeded = readFileSync(stampPath, 'utf-8').trim() === repoRef.trim();
    } catch { /* unreadable stamp → re-seed */ }
  }

  const stamp = (): void => {
    try { writeFileSync(stampPath, `${repoRef}\n`); } catch { /* best-effort */ }
  };

  const local = resolveLocalOpenpalmDir();
  if (local) {
    // ALWAYS refresh the system-managed stack assets (cheap local copy) so a
    // re-install over an existing OP_HOME picks up the current compose files
    // even when the skeleton stamp already matches (#472). User-owned files stay
    // seed-if-missing via the copyTree below.
    const refreshed = refreshManagedStackAssets(local, homeDir);
    if (refreshed.length) logger.debug('refreshed managed stack assets', { refreshed });
    if (alreadySeeded) {
      logger.debug('skeleton already seeded for this version — managed assets refreshed, skipping full seed', { repoRef });
      return;
    }
    logger.debug('seeding .openpalm from local source', { src: local, repoRef });
    copyTree(local, homeDir, { skipExisting: true });
    stamp();
    return;
  }

  // No local skeleton (pure-binary install). If already seeded for this version
  // there's nothing cheap to refresh from — skip the expensive tarball download.
  // (The packaged Electron app ships the skeleton via OPENPALM_SKELETON_DIR, so
  // it takes the local path above; this branch is the rare bare-binary case.)
  if (alreadySeeded) {
    logger.debug('skeleton already seeded and no local source to refresh from — skipping', { repoRef });
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
    // Refresh system-managed stack assets (overwrite), then seed the rest.
    refreshManagedStackAssets(srcOpenpalm, homeDir);
    copyTree(srcOpenpalm, homeDir, { skipExisting: true });
    stamp();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── UI build ─────────────────────────────────────────────────────────────────

/**
 * Locate the compiled SvelteKit UI build on disk.
 * Returns null when not found — triggers the npm registry download in seedUiBuild.
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

/**
 * Resolve the best available UI build directory at runtime.
 *
 * Priority:
 *   1. OP_HOME/data/ui/ — user-installed or auto-updated build
 *   2. Bundled / local build (Electron extraResources, OPENPALM_REPO_ROOT, source checkout)
 */
/** Filename of the build-time version stamp written into the UI build root. */
export const UI_VERSION_STAMP = '.openpalm-ui-version';

/** Read the stamped UI version from a build dir, or null if absent/unreadable. */
export function readUiBuildVersion(dir: string): string | null {
  try {
    const v = readFileSync(join(dir, UI_VERSION_STAMP), 'utf-8').trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * Resolve which UI build to run.
 *
 * Two channels exist: the bundled build (shipped inside the AppImage / source
 * tree) and `data/ui` (operator-updatable, seeded from the @openpalm/ui npm
 * registry tarball). To fix
 * the stale-`data/ui` shadowing bug AND stay forward-compatible with updating the
 * UI without shipping a new app (D5), selection is VERSION-AWARE:
 *
 *   - If only one channel has a build → use it.
 *   - If both exist → use `data/ui` ONLY when it is strictly NEWER than the
 *     bundled build (per the version stamp); otherwise prefer the bundled build.
 *     An unstamped/older `data/ui` never shadows a newer bundled build.
 *
 * This means a fresh app runs its bundled UI, and a future "update UI only" flow
 * (seed a newer-stamped build into data/ui) is picked up automatically — no app
 * reinstall required.
 */
export function resolveUiBuildDir(): string {
  const dataBuild = join(resolveDataDir(), 'ui');
  const hasData = existsSync(join(dataBuild, 'index.js'));
  // resolveLocalUiBuild()'s env/resourcesPath candidates only check the dir
  // exists, not that it holds a runnable build — require index.js before trusting it.
  const bundledRaw = resolveLocalUiBuild();
  const bundled = bundledRaw && existsSync(join(bundledRaw, 'index.js')) ? bundledRaw : null;

  if (hasData && bundled) {
    const dataVer = readUiBuildVersion(dataBuild);
    const bundledVer = readUiBuildVersion(bundled);
    // data/ui wins only when we can prove it's strictly newer.
    if (dataVer && bundledVer && compareComparableVersions(dataVer, bundledVer) > 0) return dataBuild;
    return bundled;
  }
  if (hasData) return dataBuild;
  if (bundled) return bundled;
  return dataBuild; // nothing present yet → caller triggers seedUiBuild
}

/**
 * The UI ships as `@openpalm/ui` on npm — a self-contained `adapter-node`
 * bundle (only `build/` is published; no `node_modules` is needed at runtime,
 * because the build bundles every dependency). The desktop and host updaters
 * fetch the registry TARBALL over plain HTTPS and verify its integrity hash;
 * they never invoke a package manager (the Electron runtime has none). npm gives
 * us, for free, the four things the GitHub-release path forced us to hand-roll:
 * an independent version line, `latest`/`next` dist-tag channels (prerelease-
 * aware — unlike `releases/latest`, which silently excludes prereleases),
 * immutable versions, and a sha512 integrity we verify fail-closed.
 */
const NPM_REGISTRY = 'https://registry.npmjs.org';
const UI_PACKAGE   = '@openpalm/ui';

interface NpmUiManifest {
  version: string;
  tarball: string;
  /** Subresource-integrity string ("sha512-<base64>"); null if the registry omitted it. */
  integrity: string | null;
}

/** Strip a single leading 'v' so a release ref (v1.2.3) becomes an npm version (1.2.3). */
function toNpmVersion(repoRef: string): string {
  return repoRef.replace(/^v/, '');
}

/**
 * The npm dist-tag channel a release stream tracks: prereleases ride `next`,
 * stable rides `latest`. `@openpalm/ui` is independently versioned (it publishes
 * on its own `publish-ui.yml` workflow, like the channel adapters), so the
 * desktop/host updaters can't compare a UI version against the app version —
 * they pick the CHANNEL from the app's release stream and then resolve the
 * newest UI on that channel.
 */
export function uiUpdateChannel(appVersion: string): 'latest' | 'next' {
  return appVersion.includes('-') ? 'next' : 'latest';
}

/**
 * Resolve the npm manifest for `@openpalm/ui` by exact version OR dist-tag.
 * `GET <registry>/@openpalm/ui/<version-or-tag>` returns the abbreviated
 * manifest (version + dist.tarball + dist.integrity). Throws on non-OK.
 */
async function fetchNpmUiManifest(versionOrTag: string): Promise<NpmUiManifest> {
  const url = `${NPM_REGISTRY}/${UI_PACKAGE}/${versionOrTag}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`npm registry returned HTTP ${res.status} for ${UI_PACKAGE}@${versionOrTag}`);
  const m = await res.json() as { version?: string; dist?: { tarball?: string; integrity?: string } };
  if (!m.version || !m.dist?.tarball) {
    throw new Error(`npm manifest for ${UI_PACKAGE}@${versionOrTag} is missing version/dist.tarball`);
  }
  return { version: m.version, tarball: m.dist.tarball, integrity: m.dist.integrity ?? null };
}

/**
 * Verify a Subresource-Integrity string against the bytes. FAIL-CLOSED: a
 * present-but-wrong hash throws (the corruption / tamper case). A registry that
 * omits the hash entirely (legacy metadata) is logged and allowed — modern npm
 * always provides one, so this only affects pathological registry responses.
 */
function verifyNpmIntegrity(data: Uint8Array, integrity: string): void {
  const entries = integrity.trim().split(/\s+/);
  const entry = entries.find(e => e.startsWith('sha512-')) ?? entries.find(e => e.startsWith('sha256-'));
  if (!entry) throw new Error(`unrecognized integrity format: ${integrity}`);
  const dash = entry.indexOf('-');
  const algo = entry.slice(0, dash);
  const expected = entry.slice(dash + 1);
  const actual = createHash(algo).update(data).digest('base64');
  if (actual !== expected) throw new Error(`UI bundle integrity mismatch (${algo})`);
}

/**
 * Download `@openpalm/ui`'s npm tarball, verify integrity, and install its
 * `build/` contents into `uiDir`. npm tarballs nest everything under `package/`
 * and we publish `files: ["build"]`, so the bundle lives at `package/build/**` —
 * strip 2 path components and filter to that subtree.
 *
 * FAIL-CLOSED + non-destructive: we throw if integrity is missing or mismatched
 * (the contract is that npm always provides a sha512), and we extract into a
 * STAGING dir and validate it has a runnable `index.js` before swapping it over
 * `uiDir` — so a truncated download or bad tarball never leaves `uiDir` empty.
 */
async function downloadNpmUiBundle(manifest: NpmUiManifest, uiDir: string, dataDir: string): Promise<void> {
  const res = await fetchWithRetry(manifest.tarball);
  if (!res.ok) throw new Error(`Failed to download UI bundle (HTTP ${res.status})`);
  const data = new Uint8Array(await res.arrayBuffer());

  // Verify BEFORE touching anything. Fail closed: a missing hash is treated as a
  // verification failure, not a warning — modern npm always supplies dist.integrity,
  // so its absence means a non-canonical/altered registry response.
  if (!manifest.integrity) {
    throw new Error(`npm manifest for ${UI_PACKAGE}@${manifest.version} has no integrity hash — refusing to install unverified`);
  }
  verifyNpmIntegrity(data, manifest.integrity);
  logger.debug('UI bundle integrity verified', { version: manifest.version });

  const tmpTar  = join(dataDir, '.ui-build.tgz.tmp');
  const staging = join(dataDir, '.ui-build.staging');
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(tmpTar, data);
    await tarExtract({
      file: tmpTar,
      cwd: staging,
      strip: 2,
      filter: (p) => p.startsWith('package/build/'),
    });
    // Validate the staged build is runnable before destroying the live one.
    if (!existsSync(join(staging, 'index.js'))) {
      throw new Error('downloaded UI bundle is missing build/index.js');
    }
    // Swap: only now do we remove the existing build and move staging into place.
    rmSync(uiDir, { recursive: true, force: true });
    renameSync(staging, uiDir);
  } finally {
    rmSync(tmpTar, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Install the UI build to OP_HOME/data/ui/.
 *
 * Copies from the local/bundled `packages/ui/build/` when available, otherwise
 * downloads the `@openpalm/ui` bundle from npm (by exact version; `repoRef` may
 * be a tag like `latest`/`next` via the admin route). Always replaces existing
 * content. data/ui/ is included in backups because backupOpenPalmHome() copies
 * all of OP_HOME/data/.
 */
export async function seedUiBuild(repoRef: string, dataDir: string, options?: { forceRemote?: boolean }): Promise<void> {
  const uiDir = join(dataDir, 'ui');
  mkdirSync(uiDir, { recursive: true });

  const local = options?.forceRemote ? null : resolveLocalUiBuild();
  if (local) {
    logger.debug('seeding UI build from local source', { src: local });
    copyTree(local, uiDir);
    // The build script (stamp-version.mjs) writes .openpalm-ui-version into build/.
    // A local build missing it would seed an UNSTAMPED data/ui, which makes the
    // update check unable to read the running UI version. Surface it loudly rather
    // than silently degrade update behavior.
    if (!readUiBuildVersion(uiDir)) {
      logger.warn('seeded UI build has no version stamp — auto-update comparison will be unreliable', { src: local });
    }
    return;
  }

  const manifest = await fetchNpmUiManifest(toNpmVersion(repoRef));
  logger.debug('downloading UI build from npm', { version: manifest.version });
  await downloadNpmUiBundle(manifest, uiDir, dataDir);
}

// ── UI update check ──────────────────────────────────────────────────────────

export interface UiBuildUpdateResult {
  updated: boolean;
  latestVersion: string | null;
  error?: string;
}

/**
 * Check npm for a newer `@openpalm/ui` build and apply it if one exists.
 *
 * `@openpalm/ui` is INDEPENDENTLY versioned, so we do NOT compare against the
 * app/platform version. We pick the dist-tag CHANNEL from the app's release
 * stream (`appVersion`: prerelease → `next`, stable → `latest`) and compare the
 * newest UI on that channel against the version actually on disk (the stamp in
 * the resolved build). This tracks prerelease UIs for prerelease apps and fixes
 * the `releases/latest`-excludes-prereleases blind spot.
 *
 * When an update is available:
 *   1. Move data/ui/ → data/backups/ui-{timestamp}/ (preserves the old build)
 *   2. Download the npm bundle (integrity-verified) and extract to data/ui/
 *
 * Non-fatal: any network or extraction error returns { updated: false, error }.
 * The caller should proceed with the existing build on failure.
 */
export async function checkAndUpdateUiBuild(
  appVersion: string,
  dataDir: string,
): Promise<UiBuildUpdateResult> {
  try {
    const channel  = uiUpdateChannel(appVersion);
    const manifest = await fetchNpmUiManifest(channel);
    const latestVersion = manifest.version;

    // Compare against the UI build currently on disk, NOT the app version — the
    // UI floats on its own version line, so the platform/app version is not
    // directly comparable for freshness. We DO use the app version as a fallback
    // major-version guard when the current UI build is unstamped: that preserves
    // the current release lane without guessing across majors.
    const currentUiVersion = readUiBuildVersion(resolveUiBuildDir());
    const currentVersionForPolicy = currentUiVersion ?? appVersion;

    if (!isSameMajorVersion(latestVersion, currentVersionForPolicy)) {
      logger.debug('UI build update blocked by major-version policy', {
        currentUi: currentUiVersion ?? '(unstamped)',
        policyBase: currentVersionForPolicy,
        latest: latestVersion,
        channel,
      });
      return { updated: false, latestVersion };
    }

    if (currentUiVersion && compareComparableVersions(latestVersion, currentUiVersion) <= 0) {
      logger.debug('UI build is up to date', { currentUi: currentUiVersion, latest: latestVersion, channel });
      return { updated: false, latestVersion };
    }
    if (!currentUiVersion) {
      logger.debug('UI build is unstamped — refreshing from npm to re-establish a known version', { latest: latestVersion, channel });
    }

    // Back up the existing UI build before replacing it. (Automatic rollback on
    // a failed start is deferred — see ui-distribution-gap-analysis.md G1.)
    const uiDir = join(dataDir, 'ui');
    if (existsSync(join(uiDir, 'index.js'))) {
      const backupDir = join(resolveBackupsDir(), `ui-${Date.now()}`);
      mkdirSync(resolveBackupsDir(), { recursive: true });
      renameSync(uiDir, backupDir);
      logger.debug('backed up UI build before update', { backup: backupDir });
    }

    await downloadNpmUiBundle(manifest, uiDir, dataDir);
    logger.debug('UI build updated', { from: currentUiVersion ?? '(unstamped)', to: latestVersion });

    return { updated: true, latestVersion };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.debug('UI build update check failed (non-fatal)', { error });
    return { updated: false, latestVersion: null, error };
  }
}
