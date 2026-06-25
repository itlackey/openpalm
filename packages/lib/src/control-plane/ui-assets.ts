/**
 * Runtime asset seeding and resolution for the UI build and OP_HOME skeleton.
 *
 * These functions are consumed by both the CLI and the Electron shell — they
 * must use only Node.js-compatible APIs (no Bun.spawn, Bun.write, etc.).
 *
 * Skeleton (packages/skeleton/) resolution order:
 *   1. OPENPALM_REPO_ROOT env var → packages/skeleton/ (dev override)
 *   2. OPENPALM_SKELETON_DIR env var → set by Electron from extraResources
 *   3. require.resolve('@openpalm/skeleton/package.json') → npm/CLI dep
 *   4. null → seedOpenPalmDir throws with an actionable error message
 *
 * UI build resolution order:
 *   1. OPENPALM_REPO_ROOT env var → packages/ui/build/ (dev override)
 *   2. Electron extraResources → ui-build/ alongside the asar
 *   3. Relative to import.meta.url — works for `bun run` / source installs
 *   4. Relative to process.execPath — works for compiled Bun binary in repo
 *   5. null → remote download (from the @openpalm/ui npm registry tarball)
 */
import {
  existsSync, mkdirSync, readdirSync, copyFileSync,
  writeFileSync, readFileSync, rmSync, realpathSync, renameSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { x as tarExtract } from 'tar';

const _require = createRequire(import.meta.url);
import { resolveBackupsDir, resolveDataDir } from './home.js';
import { createLogger } from '../logger.js';
import { compareComparableVersions, isSameMajorVersion, normalizeVersion, distTagForVersion } from './versioning.js';
import { overwriteSystemTree } from './core-assets.js';

const logger = createLogger('lib:ui-assets');

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
 * Locate the skeleton directory (packages/skeleton/ or equivalent).
 * Used by seedOpenPalmDir to avoid a network download when running from source.
 */
export function resolveLocalOpenpalmDir(): string | null {
  return resolveLocalCandidate(
    // 1. Explicit dev override — OPENPALM_REPO_ROOT points to repo root,
    //    skeleton is now at packages/skeleton/
    () => process.env.OPENPALM_REPO_ROOT
      ? join(process.env.OPENPALM_REPO_ROOT, 'packages', 'skeleton')
      : null,
    // 2. Electron extraResources — openpalm-skeleton/ placed alongside the asar
    //    (set by Electron main from process.resourcesPath/openpalm-skeleton)
    () => process.env.OPENPALM_SKELETON_DIR ?? null,
    // 3. @openpalm/skeleton installed as a package dep (CLI bundled, npm install)
    () => {
      try {
        return dirname(_require.resolve('@openpalm/skeleton/package.json'));
      } catch { return null; }
    },
    // 4. Source-relative fallback — works when running from the repo tree
    //    (bun run, bun test, ts-node). This file lives at
    //    packages/lib/src/control-plane/ui-assets.ts; skeleton is four levels up
    //    at packages/skeleton/.
    () => {
      try {
        const meta = fileURLToPath(import.meta.url);
        return join(dirname(meta), '..', '..', '..', '..', 'packages', 'skeleton');
      } catch { return null; }
    },
    // 5. null — cold start without @openpalm/skeleton installed
    //    (seedOpenPalmDir will throw a helpful error in this case)
    () => null,
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
): Promise<{ updated: string[]; backupDir: string | null }> {
  const stampPath = join(homeDir, SKELETON_VERSION_STAMP);
  let alreadySeeded = false;
  if (existsSync(stampPath)) {
    try {
      // Compare normalized so an old `v`-prefixed stamp still matches a bare repoRef.
      alreadySeeded = normalizeVersion(readFileSync(stampPath, 'utf-8')) === normalizeVersion(repoRef);
    } catch { /* unreadable stamp → re-seed */ }
  }

  const stamp = (): void => {
    try { writeFileSync(stampPath, `${repoRef}\n`); } catch { /* best-effort */ }
  };

  const local = resolveLocalOpenpalmDir();
  if (local) {
    // ALWAYS overwrite the entire MANAGED system/ tree (compose stack + system
    // OpenCode config) from the release skeleton, so a re-install/update picks up
    // the current managed assets even when the skeleton stamp already matches
    // (#472) — changed files are backed up first. User-owned files (config/,
    // knowledge/, workspace/, the tool/skill/task seeds) stay seed-if-missing via
    // the copyTree below; data/ + state/ are never touched here.
    const { updated, backupDir } = overwriteSystemTree(local, homeDir);
    if (updated.length) logger.debug('overwrote managed system/ tree', { refreshed: updated });
    if (alreadySeeded) {
      // Even when the stamp matches, ALWAYS seed-if-missing the service-required
      // files under data/ — above all the assistant/guardian/portal tool manifests
      // (data/*/tools/package.json) that those containers bind-mount and `bun update`
      // from at startup. A home stamped at the current version but missing them
      // (older install, an incomplete earlier seed) would otherwise stay broken
      // forever, because the old guard skipped the copy entirely. `skipExisting`
      // preserves any existing file. config/ + knowledge/ are user-owned and
      // intentionally NOT re-materialized here (#472: a removed user file stays
      // removed). copyTree no-ops if the skeleton has no data/.
      copyTree(join(local, 'data'), join(homeDir, 'data'), { skipExisting: true });
      logger.debug('skeleton already seeded — refreshed managed assets + service data defaults', { repoRef });
      return { updated, backupDir };
    }
    logger.debug('seeding .openpalm from local source', { src: local, repoRef });
    copyTree(local, homeDir, { skipExisting: true });
    stamp();
    return { updated, backupDir };
  }

  // No local skeleton found — this is a cold start without @openpalm/skeleton
  // installed (and without OPENPALM_REPO_ROOT or OPENPALM_SKELETON_DIR set).
  // Throw a helpful error so the caller can surface an actionable message.
  throw new Error(
    'Cannot locate @openpalm/skeleton. Set OPENPALM_REPO_ROOT (dev) or install @openpalm/skeleton: ' +
    'npm install @openpalm/skeleton@' + (process.env.OP_SKELETON_VERSION ?? process.env.PLATFORM_VERSION ?? '<version>')
  );
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
    // data/ui IS present but is being IGNORED — execution de-routes to the frozen
    // bundled lib (the asar copy). This is exactly the "stale control plane runs
    // silently" failure the thin-harness design (§6.1, Risk #1) calls out: a
    // de-routed install must be VISIBLE, never silent. Emit a structured warning
    // distinguishing the missing/unparseable-stamp case (the dangerous one — a
    // freshly downloaded but unstamped data/ui can never win) from the simply
    // not-newer case.
    if (!dataVer) {
      logger.warn('data/ui present but UNSTAMPED — ignoring it and running the frozen bundled UI build; the downloaded control plane is NOT executing', {
        dataBuild, bundled, bundledVersion: bundledVer ?? '(unstamped)',
      });
    } else {
      logger.warn('data/ui present but not strictly newer than the bundled build — running the frozen bundled UI build', {
        dataBuild, dataVersion: dataVer, bundled, bundledVersion: bundledVer ?? '(unstamped)',
      });
    }
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
  /**
   * Minimum native harness contract this UI build requires (design §5.3). A
   * `@openpalm/ui` build that uses an IPC method / env key introduced at
   * contract N declares `minHarnessContract: N` in its package.json. The harness
   * refuses to self-update onto a build whose minHarnessContract exceeds the
   * contract it provides (it prompts a re-download instead of failing at
   * runtime). Absent ⇒ 0 (pre-contract / no native dependency).
   */
  minHarnessContract: number;
}

/** A declared platform update channel — the two npm dist-tags the UI publishes on. */
export type UiUpdateChannel = 'latest' | 'next';

/**
 * Read an explicitly DECLARED platform channel from the environment, if any.
 *
 * This decouples the channel from the harness/app version (§6.4 of the
 * thin-harness design): a *stable* host can opt into a `next` control plane for
 * testing by setting `OP_UI_CHANNEL=next` WITHOUT faking its app version, and
 * the choice survives the harness↔platform version split. Returns null when
 * unset/blank or not one of the two valid dist-tags (caller falls back to
 * deriving the channel from the version).
 */
export function declaredUiChannel(): UiUpdateChannel | null {
  const raw = (process.env.OP_UI_CHANNEL ?? '').trim().toLowerCase();
  return raw === 'latest' || raw === 'next' ? raw : null;
}

/**
 * The npm dist-tag channel a release stream tracks: prereleases ride `next`,
 * stable rides `latest`. `@openpalm/ui` is independently versioned (it publishes
 * on its own `publish-ui.yml` workflow, like the channel adapters), so the
 * desktop/host updaters can't compare a UI version against the app version —
 * they pick the CHANNEL from the app's release stream and then resolve the
 * newest UI on that channel.
 *
 * An EXPLICITLY declared channel (`OP_UI_CHANNEL` or the `channel` argument)
 * always wins over the version-derived default, so a stable host can opt into a
 * `next` control plane without faking its version. Falls back to
 * `distTagForVersion` (the canonical prerelease→channel mapping from Stage 1).
 */
export function uiUpdateChannel(appVersion: string, channel?: UiUpdateChannel): UiUpdateChannel {
  return channel ?? declaredUiChannel() ?? distTagForVersion(appVersion);
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
  const m = await res.json() as { version?: string; dist?: { tarball?: string; integrity?: string }; minHarnessContract?: unknown };
  if (!m.version || !m.dist?.tarball) {
    throw new Error(`npm manifest for ${UI_PACKAGE}@${versionOrTag} is missing version/dist.tarball`);
  }
  const rawMin = typeof m.minHarnessContract === 'number' ? m.minHarnessContract : Number(m.minHarnessContract);
  const minHarnessContract = Number.isFinite(rawMin) && rawMin > 0 ? rawMin : 0;
  return { version: m.version, tarball: m.dist.tarball, integrity: m.dist.integrity ?? null, minHarnessContract };
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

  // normalizeVersion strips a leading 'v' so a release ref (v1.2.3) becomes the
  // npm version (1.2.3) the registry manifest endpoint expects.
  const manifest = await fetchNpmUiManifest(normalizeVersion(repoRef));
  logger.debug('downloading UI build from npm', { version: manifest.version });
  await downloadNpmUiBundle(manifest, uiDir, dataDir);
}

// ── UI update check ──────────────────────────────────────────────────────────

export interface UiBuildUpdateResult {
  updated: boolean;
  latestVersion: string | null;
  error?: string;
  /**
   * Set when a newer UI build EXISTS but its `minHarnessContract` exceeds the
   * native harness contract this host provides (design §5.3). The control plane
   * is NOT self-updated (running newer-UI-on-older-harness would fail at runtime);
   * the caller should surface "a new OpenPalm app is required" and link the
   * re-download. Carries the contract the build needs so the message can be exact.
   */
  redownloadRequired?: boolean;
  requiredHarnessContract?: number;
  /**
   * The on-disk backup of the PREVIOUS UI build, kept for rollback. Present only
   * when `updated` is true and a prior build existed. The supervisor uses this to
   * restore the old build if the new one fails to start (§4.4 / §6).
   */
  backupDir?: string;
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
  channelOverride?: UiUpdateChannel,
  /**
   * The native harness contract version this supervisor provides (design §5.3).
   * When the newest UI build declares `minHarnessContract` greater than this, the
   * build is NOT pulled — the function returns `redownloadRequired` instead of
   * silently installing a UI the harness can't satisfy. Omitted / null on
   * non-Electron supervisors (CLI), where every UI build is by definition runnable
   * (the served UI floats with data/ui; there is no native bridge to outgrow), so
   * the gate is skipped.
   */
  harnessContract?: number | null,
): Promise<UiBuildUpdateResult> {
  // Hoisted outside try so the catch block can return it for supervisor restore (§4.4/§6).
  let uiBuildBackupDir: string | undefined;
  try {
    const channel  = uiUpdateChannel(appVersion, channelOverride);
    const manifest = await fetchNpmUiManifest(channel);
    const latestVersion = manifest.version;

    // §5.3 self-update-vs-redownload gate. Only meaningful when a native harness
    // contract is supplied (Electron). If the newer build needs a contract this
    // harness does not provide, refuse the pull and ask the user to re-download
    // the app — never run newer-UI-on-older-harness (undefined IPC → TypeError;
    // missing env → 503).
    if (
      typeof harnessContract === 'number' &&
      manifest.minHarnessContract > harnessContract
    ) {
      logger.warn('UI build requires a newer harness — re-download required', {
        latest: latestVersion,
        minHarnessContract: manifest.minHarnessContract,
        harnessContract,
        channel,
      });
      return {
        updated: false,
        latestVersion,
        redownloadRequired: true,
        requiredHarnessContract: manifest.minHarnessContract,
      };
    }

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

    // Back up the existing UI build before replacing it. The supervisor uses
    // uiBuildBackupDir to restore the old build if the new one fails to start (§4.4/§6).
    const uiDir = join(dataDir, 'ui');
    if (existsSync(join(uiDir, 'index.js'))) {
      uiBuildBackupDir = join(resolveBackupsDir(), `ui-${Date.now()}`);
      mkdirSync(resolveBackupsDir(), { recursive: true });
      renameSync(uiDir, uiBuildBackupDir);
      logger.debug('backed up UI build before update', { backup: uiBuildBackupDir });
    }

    await downloadNpmUiBundle(manifest, uiDir, dataDir);
    logger.debug('UI build updated', { from: currentUiVersion ?? '(unstamped)', to: latestVersion });

    return { updated: true, latestVersion, backupDir: uiBuildBackupDir };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.debug('UI build update check failed (non-fatal)', { error });
    // Include backupDir even on failure: if the backup was created before the
    // download threw, the supervisor can restore the old build (§4.4 / §6).
    return { updated: false, latestVersion: null, error, backupDir: uiBuildBackupDir };
  }
}

// ── Skeleton npm hot-swap ────────────────────────────────────────────────────
//
// The skeleton (`@openpalm/skeleton`) is the managed tree that install/update
// overwrites into OP_HOME/system/ on every apply(). It is independently versioned
// and ships as an npm package so the control plane can hot-swap it at runtime
// without a native-shell update — exactly the same channel/verify/stage/rename/
// stamp/backup pipeline as the UI build above (§2, §4.4).
//
// NOTE: the skeleton's managed content lands at OP_HOME/system/, NOT at OP_HOME
// directly. The tarball publishes the skeleton tree at `package/` (the npm default
// wrapper). We strip 1 component and extract into a staging dir, then rename into
// OP_HOME/system/ — the same atomic rename pattern used for the UI build.

const SKELETON_PACKAGE = '@openpalm/skeleton';

interface NpmSkeletonManifest {
  version: string;
  tarball: string;
  /** Subresource-integrity string ("sha512-<base64>"); null if the registry omitted it. */
  integrity: string | null;
}

/** Read the stamped skeleton version from OP_HOME, or null if absent/unreadable. */
export function readSkeletonVersion(homeDir: string): string | null {
  try {
    const v = readFileSync(join(homeDir, SKELETON_VERSION_STAMP), 'utf-8').trim();
    return v || null;
  } catch {
    return null;
  }
}

async function fetchNpmSkeletonManifest(versionOrTag: string): Promise<NpmSkeletonManifest> {
  const url = `${NPM_REGISTRY}/${SKELETON_PACKAGE}/${versionOrTag}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`npm registry returned HTTP ${res.status} for ${SKELETON_PACKAGE}@${versionOrTag}`);
  const m = await res.json() as { version?: string; dist?: { tarball?: string; integrity?: string } };
  if (!m.version || !m.dist?.tarball) {
    throw new Error(`npm manifest for ${SKELETON_PACKAGE}@${versionOrTag} is missing version/dist.tarball`);
  }
  return { version: m.version, tarball: m.dist.tarball, integrity: m.dist.integrity ?? null };
}

/**
 * Download `@openpalm/skeleton` from npm, verify integrity, and install its
 * contents into `homeDir/system/`. The tarball wraps the skeleton tree under
 * `package/` (npm standard); we strip 1 path component and extract everything
 * that is NOT `package/system/` into the staging dir, then validate and rename.
 *
 * FAIL-CLOSED + non-destructive: throws if integrity is missing or wrong.
 * Extracts into a staging dir, validates, then atomically renames into system/.
 */
async function downloadNpmSkeletonBundle(manifest: NpmSkeletonManifest, homeDir: string, dataDir: string): Promise<void> {
  const res = await fetchWithRetry(manifest.tarball);
  if (!res.ok) throw new Error(`Failed to download skeleton bundle (HTTP ${res.status})`);
  const data = new Uint8Array(await res.arrayBuffer());

  if (!manifest.integrity) {
    throw new Error(
      `npm manifest for ${SKELETON_PACKAGE}@${manifest.version} has no integrity hash — refusing to install unverified`,
    );
  }
  verifyNpmIntegrity(data, manifest.integrity);
  logger.debug('skeleton bundle integrity verified', { version: manifest.version });

  const tmpTar  = join(dataDir, '.skeleton.tgz.tmp');
  const staging = join(dataDir, '.skeleton.staging');
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(tmpTar, data);
    // npm wraps under `package/`; strip 1 component to land the skeleton tree directly in staging.
    await tarExtract({ file: tmpTar, cwd: staging, strip: 1 });
    // Validate: the skeleton must contain system/stack/
    if (!existsSync(join(staging, 'system', 'stack'))) {
      throw new Error('downloaded skeleton bundle is missing system/stack/');
    }
    // Atomically replace OP_HOME/system/ from the staged skeleton's system/ subtree.
    const systemSrc = join(staging, 'system');
    const systemDest = join(homeDir, 'system');
    rmSync(systemDest, { recursive: true, force: true });
    renameSync(systemSrc, systemDest);
  } finally {
    rmSync(tmpTar, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

export interface SkeletonUpdateResult {
  updated: boolean;
  latestVersion: string | null;
  error?: string;
}

/**
 * Check npm for a newer `@openpalm/skeleton` and apply it if one exists.
 *
 * The skeleton is versioned on the same channel as the platform (prerelease →
 * `next`, stable → `latest`). The version on disk is the `.skeleton-version`
 * stamp in OP_HOME; the npm manifest provides the target version and integrity.
 *
 * When an update is available:
 *   1. Move OP_HOME/system/ → data/backups/skeleton-{ts}/ (preserves the old tree)
 *   2. Download and verify the npm bundle (integrity fail-closed)
 *   3. Atomically rename the staged system/ into OP_HOME/system/
 *   4. Stamp SKELETON_VERSION_STAMP with the exact npm version
 *
 * Never auto-crosses a major version. Non-fatal: network/extraction errors return
 * { updated: false, error } so the caller proceeds with the existing skeleton.
 */
export async function checkAndUpdateSkeleton(
  appVersion: string,
  homeDir: string,
  dataDir: string,
  channelOverride?: UiUpdateChannel,
): Promise<SkeletonUpdateResult> {
  let skelBackupDir: string | undefined;
  try {
    const channel = uiUpdateChannel(appVersion, channelOverride);
    const manifest = await fetchNpmSkeletonManifest(channel);
    const latestVersion = manifest.version;

    const currentVersion = readSkeletonVersion(homeDir);
    const currentVersionForPolicy = currentVersion ?? appVersion;

    if (!isSameMajorVersion(latestVersion, currentVersionForPolicy)) {
      logger.debug('skeleton update blocked by major-version policy', {
        current: currentVersion ?? '(unstamped)',
        policyBase: currentVersionForPolicy,
        latest: latestVersion,
        channel,
      });
      return { updated: false, latestVersion };
    }

    if (currentVersion && compareComparableVersions(latestVersion, currentVersion) <= 0) {
      logger.debug('skeleton is up to date', { current: currentVersion, latest: latestVersion, channel });
      return { updated: false, latestVersion };
    }
    if (!currentVersion) {
      logger.debug('skeleton is unstamped — refreshing from npm', { latest: latestVersion, channel });
    }

    // Back up the existing system/ tree before replacing it.
    const systemDir = join(homeDir, 'system');
    if (existsSync(systemDir)) {
      skelBackupDir = join(resolveBackupsDir(), `skeleton-${Date.now()}`);
      mkdirSync(resolveBackupsDir(), { recursive: true });
      renameSync(systemDir, skelBackupDir);
      logger.debug('backed up skeleton before update', { backup: skelBackupDir });
    }

    await downloadNpmSkeletonBundle(manifest, homeDir, dataDir);

    // Stamp the exact npm version (bare, no `v`) so future checks compare correctly.
    const stampPath = join(homeDir, SKELETON_VERSION_STAMP);
    writeFileSync(stampPath, `${normalizeVersion(latestVersion)}\n`);
    logger.debug('skeleton updated', { from: currentVersion ?? '(unstamped)', to: latestVersion });

    return { updated: true, latestVersion };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.debug('skeleton update check failed (non-fatal)', { error });
    // If the backup was created before the download/extraction threw, restore it
    // so the system/ tree is left in its previous working state (§6).
    if (skelBackupDir && !existsSync(join(homeDir, 'system'))) {
      try {
        renameSync(skelBackupDir, join(homeDir, 'system'));
        logger.debug('skeleton backup restored after failed update', { restored: skelBackupDir });
      } catch (restoreErr) {
        logger.debug('skeleton backup restore also failed', {
          backup: skelBackupDir,
          restoreError: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
        });
      }
    }
    return { updated: false, latestVersion: null, error };
  }
}
