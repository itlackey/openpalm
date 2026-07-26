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
 *   4. null → applyHomeSeed throws with an actionable error message
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
import { errMessage } from './errors.js';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const _require = createRequire(import.meta.url);
import { resolveDataDir } from './home.js';
import { createLogger } from '../logger.js';
import { compareComparableVersions, normalizeVersion, distTagForVersion } from './versioning.js';
import { overwriteSystemTree } from './core-assets.js';
import {
  NPM_REGISTRY,
  fetchWithRetry,
  stageNpmBundle,
  checkAndUpdateNpmBundle,
  type NpmBundleManifest,
} from './npm-bundle-updater.js';

const logger = createLogger('lib:ui-assets');

// ── Shared helpers ───────────────────────────────────────────────────────────

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
 * Used by applyHomeSeed to avoid a network download when running from source.
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
    //    (applyHomeSeed will throw a helpful error in this case)
    () => null,
  );
}

/**
 * Version stamp written by checkAndUpdateSkeleton after an npm hot-swap.
 * Used by §4.2 pinning controls to read which skeleton version is on disk.
 * NOT used by applyHomeSeed to gate seeding — ownership alone (§1) determines
 * write policy; no stamp gate is needed or allowed (constitution §8).
 */
export const SKELETON_VERSION_STAMP = '.skeleton-version';

/**
 * Record which skeleton version was seeded. Without it checkAndUpdateSkeleton
 * treats a fresh install as stale and re-swaps system/ on a live stack.
 * Fails open: an undeterminable version leaves the home unstamped, as before.
 */
function stampSeededSkeletonVersion(sourceDir: string, homeDir: string): void {
  try {
    const raw = readFileSync(join(sourceDir, 'package.json'), 'utf-8');
    const version = normalizeVersion(JSON.parse(raw)?.version);
    if (!version) {
      logger.debug('skeleton package.json has no version — leaving home unstamped');
      return;
    }
    writeFileSync(join(homeDir, SKELETON_VERSION_STAMP), `${version}\n`);
    logger.debug('stamped seeded skeleton version', { version });
  } catch (err) {
    logger.debug('could not stamp skeleton version — leaving home unstamped', {
      err: errMessage(err),
    });
  }
}

/**
 * Seed the bundled `.openpalm/` skeleton into OP_HOME.
 *
 * Called on every install/update. Per constitution §1 and §8:
 *   - system/ (managed tree) is ALWAYS overwritten from the release skeleton.
 *   - User trees (config/, knowledge/, workspace/, data/) are seeded-once via
 *     copyTree({skipExisting:true}) — existing files are never overwritten.
 *
 * No version-stamp gate. skipExisting already preserves user edits, so running
 * unconditionally is both correct and simpler. Changed managed files are backed
 * up first by overwriteSystemTree.
 */
export async function applyHomeSeed(
  repoRef: string,
  homeDir: string,
  _configDir: string,
  dataDir: string,
): Promise<{ updated: string[]; backupDir: string | null }> {
  let local = resolveLocalOpenpalmDir();
  let staged: string | null = null;

  // No local skeleton found — this is a cold start without @openpalm/skeleton on
  // disk (a compiled CLI binary or npm-global without the dep, and without
  // OPENPALM_REPO_ROOT / OPENPALM_SKELETON_DIR set). Download it from npm rather
  // than forcing the user to `npm install @openpalm/skeleton` by hand — the same
  // local-or-download model seedUiBuild already uses for the UI bundle.
  if (!local) {
    logger.debug('no local skeleton found — downloading @openpalm/skeleton from npm', { repoRef });
    try {
      staged = await fetchRemoteSkeleton(repoRef, dataDir);
    } catch (err) {
      throw new Error(
        `Could not obtain @openpalm/skeleton: ${errMessage(err)}. ` +
        'Check network access, or set OPENPALM_REPO_ROOT to a source checkout for development.',
      );
    }
    local = staged;
  }

  try {
    // ALWAYS overwrite the entire MANAGED system/ tree (compose stack + system
    // OpenCode config) from the release skeleton — changed files are backed up first.
    const { updated, backupDir } = overwriteSystemTree(local, homeDir);
    if (updated.length) logger.debug('overwrote managed system/ tree', { refreshed: updated });
    // Seed user/data trees once — skipExisting preserves any existing file so
    // user edits, removed files, and service-generated data are never touched.
    logger.debug('seeding .openpalm from skeleton source', { src: local, repoRef });
    copyTree(local, homeDir, { skipExisting: true });
    stampSeededSkeletonVersion(local, homeDir);
    return { updated, backupDir };
  } finally {
    // Clean up the staged download (no-op when seeding from a local checkout).
    if (staged) rmSync(staged, { recursive: true, force: true });
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
const UI_PACKAGE   = '@openpalm/ui';

interface NpmUiManifest extends NpmBundleManifest {
  /**
   * Minimum native harness contract this UI build requires (design §5.3). A
   * `@openpalm/ui` build that uses an IPC method / env key introduced at
   * contract N declares `minHarnessContract: N` in its package.json. The harness
   * refuses to self-update onto a build whose minHarnessContract exceeds the
   * contract it provides (it prompts a re-download instead of failing at
   * runtime).
   *
   * `null` when the manifest doesn't declare the field at all (pre-contract
   * package.json) or declares a non-numeric/non-positive value. Callers decide
   * their own policy for `null`:
   *   - `checkAndUpdateUiBuild`'s self-update gate treats it as "no declared
   *     requirement" and skips the check (there's an existing, working UI
   *     build to fall back to if the assumption is wrong).
   *   - `seedUiBuild`'s fresh-install gate (remediation 3.2) treats it as
   *     fail-closed instead — there is no existing build to fall back to on a
   *     first launch, so an unverifiable requirement must not be assumed safe.
   */
  minHarnessContract: number | null;
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
  const minHarnessContract = Number.isFinite(rawMin) && rawMin > 0 ? rawMin : null;
  return { version: m.version, tarball: m.dist.tarball, integrity: m.dist.integrity ?? null, minHarnessContract };
}

/**
 * Resolve a channel to the npm version ref to install.
 *
 *   `latest` → the @latest dist-tag (newest STABLE) — unchanged.
 *   `next`   → the NEWEST published version across ALL dist-tags.
 *
 * Why not just `@next`: prereleases publish to a SUFFIX dist-tag (X.Y.Z-beta.N →
 * `beta`, -rc.N → `rc`), NOT a single moving `next` tag — so the `next` tag goes
 * stale (it sat at 0.12.0-rc.8 while betas shipped to `beta`). Resolving `@next`
 * therefore froze (or downgraded) the prerelease channel. Mirroring the Docker
 * resolver (which lists tags and picks the newest on-channel), take max(dist-tags)
 * = the true bleeding edge (latest beta/rc/stable, whichever is newest).
 */
async function resolveChannelRef(pkg: string, channel: UiUpdateChannel): Promise<string> {
  if (channel === 'latest') return 'latest';
  const res = await fetchWithRetry(`${NPM_REGISTRY}/-/package/${encodeURIComponent(pkg)}/dist-tags`);
  if (!res.ok) throw new Error(`npm registry returned HTTP ${res.status} for ${pkg} dist-tags`);
  const tags = await res.json() as Record<string, unknown>;
  const versions = Object.values(tags).filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (versions.length === 0) return 'next';
  return versions.reduce((newest, v) => (compareComparableVersions(v, newest) > 0 ? v : newest));
}

/**
 * Download `@openpalm/ui`'s npm tarball, verify integrity, and install its
 * `build/` contents into `uiDir`. npm tarballs nest everything under `package/`
 * and we publish `files: ["build"]`, so the bundle lives at `package/build/**` —
 * strip 2 path components and filter to that subtree.
 *
 * FAIL-CLOSED + non-destructive: stageNpmBundle throws if integrity is missing or
 * mismatched (the contract is that npm always provides a sha512) and validates the
 * staged build has a runnable `index.js` before we swap it over `uiDir` — so a
 * truncated download or bad tarball never leaves `uiDir` empty.
 */
async function downloadNpmUiBundle(manifest: NpmUiManifest, uiDir: string, dataDir: string): Promise<void> {
  const staging = await stageNpmBundle(manifest, dataDir, {
    packageName: UI_PACKAGE,
    label: 'UI',
    tmpTarName: '.ui-build.tgz.tmp',
    stagingName: '.ui-build.staging',
    strip: 2,
    filter: (p) => p.startsWith('package/build/'),
    validate: (s) => {
      if (!existsSync(join(s, 'index.js'))) {
        throw new Error('downloaded UI bundle is missing build/index.js');
      }
    },
  });
  try {
    // Swap: the staged build IS the artifact — remove the live build and move it in.
    rmSync(uiDir, { recursive: true, force: true });
    renameSync(staging, uiDir);
  } finally {
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
 *
 * `harnessContract`: the native harness contract version this caller provides
 * (design §5.3), same meaning as `checkAndUpdateUiBuild`'s parameter of the
 * same name. Only meaningful for the REMOTE-download branch — a local/bundled
 * build comes from the same source tree as the harness, so there is no
 * cross-version compatibility question. Fresh-install FAIL-CLOSED (remediation
 * 3.2): unlike `checkAndUpdateUiBuild`'s self-update gate, which falls back to
 * the existing working build on an undeclared `minHarnessContract`, a fresh
 * seed has no existing build to fall back to — so when a harness contract is
 * supplied, a manifest that doesn't declare a comparable `minHarnessContract`
 * is refused rather than assumed compatible. Omit `harnessContract` (CLI /
 * non-Electron callers) to skip the gate entirely, matching
 * `checkAndUpdateUiBuild`.
 */
export async function seedUiBuild(
  repoRef: string,
  dataDir: string,
  options?: { forceRemote?: boolean },
  harnessContract?: number | null,
): Promise<void> {
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

  if (typeof harnessContract === 'number') {
    if (manifest.minHarnessContract === null) {
      throw new Error(
        `npm manifest for @openpalm/ui@${manifest.version} does not declare minHarnessContract — refusing to fresh-seed onto harness contract v${harnessContract} without a verifiable compatibility declaration`,
      );
    }
    if (manifest.minHarnessContract > harnessContract) {
      throw new Error(
        `@openpalm/ui@${manifest.version} needs harness contract v${manifest.minHarnessContract}, but this harness only provides v${harnessContract} — re-download the app instead of fresh-seeding an incompatible UI build`,
      );
    }
  }

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
  const uiDir = join(dataDir, 'ui');
  return checkAndUpdateNpmBundle<NpmUiManifest, UiBuildUpdateResult>({
    appVersion,
    logLabel: 'UI build',
    resolveManifest: async () =>
      fetchNpmUiManifest(await resolveChannelRef(UI_PACKAGE, uiUpdateChannel(appVersion, channelOverride))),
    // Compare against the UI build currently on disk, NOT the app version — the
    // UI floats on its own version line. The app version is only the fallback
    // major-version guard when the on-disk build is unstamped.
    readCurrentVersion: () => readUiBuildVersion(resolveUiBuildDir()),
    // §5.3 self-update-vs-redownload gate. Only meaningful when a native harness
    // contract is supplied (Electron). If the newer build needs a contract this
    // harness does not provide, refuse the pull and ask the user to re-download
    // the app — never run newer-UI-on-older-harness (undefined IPC → TypeError;
    // missing env → 503).
    preflight: (manifest) => {
      // manifest.minHarnessContract === null means the manifest doesn't declare
      // a requirement (pre-contract package.json) — this self-update path has an
      // existing, working build to fall back to, so an undeclared requirement is
      // treated as "no requirement" rather than refused (contrast seedUiBuild's
      // fresh-install gate below, which has no existing build to fall back to).
      if (typeof harnessContract === 'number' && manifest.minHarnessContract !== null && manifest.minHarnessContract > harnessContract) {
        logger.warn('UI build requires a newer harness — re-download required', {
          latest: manifest.version,
          minHarnessContract: manifest.minHarnessContract,
          harnessContract,
        });
        return {
          updated: false,
          latestVersion: manifest.version,
          redownloadRequired: true,
          requiredHarnessContract: manifest.minHarnessContract,
        };
      }
      return null;
    },
    backup: { dir: uiDir, gate: join(uiDir, 'index.js'), prefix: 'ui' },
    install: (manifest) => downloadNpmUiBundle(manifest, uiDir, dataDir),
    // UI does NOT restore on failure: it hands the backup dir back so the
    // supervisor can restore the old build if the new one fails to start (§4.4/§6).
    restoreOnFailure: false,
    onBlockedMajor: (latestVersion) => ({ updated: false, latestVersion }),
    onUpToDate: (latestVersion) => ({ updated: false, latestVersion }),
    onSuccess: (latestVersion, backupDir) => ({ updated: true, latestVersion, backupDir }),
    onError: (error, backupDir) => ({ updated: false, latestVersion: null, error, backupDir }),
  });
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
 * Download `@openpalm/skeleton` from npm, verify integrity, and extract the FULL
 * skeleton tree into a fresh staging dir under `dataDir`, returning that path.
 * The tarball wraps the tree under `package/` (npm standard), so we strip 1 path
 * component to land config/, data/, knowledge/, system/, workspace/ directly in
 * staging.
 *
 * FAIL-CLOSED: throws if integrity is missing or wrong, or if the bundle is
 * missing system/stack/. On any failure the staging dir is removed; on success
 * the CALLER owns cleanup of the returned path.
 */
async function stageSkeletonDownload(manifest: NpmSkeletonManifest, dataDir: string): Promise<string> {
  // npm wraps the tree under `package/`; strip 1 component to land config/, data/,
  // knowledge/, system/, workspace/ directly in staging.
  return stageNpmBundle(manifest, dataDir, {
    packageName: SKELETON_PACKAGE,
    label: 'skeleton',
    tmpTarName: '.skeleton.tgz.tmp',
    stagingName: '.skeleton.staging',
    strip: 1,
    validate: (s) => {
      if (!existsSync(join(s, 'system', 'stack'))) {
        throw new Error('downloaded skeleton bundle is missing system/stack/');
      }
    },
  });
}

/**
 * Update path: download the skeleton and atomically replace OP_HOME/system/ from
 * the staged tree's system/ subtree. Non-destructive — the staged copy is
 * validated before the live system/ is touched.
 */
async function downloadNpmSkeletonBundle(manifest: NpmSkeletonManifest, homeDir: string, dataDir: string): Promise<void> {
  const staging = await stageSkeletonDownload(manifest, dataDir);
  try {
    const systemDest = join(homeDir, 'system');
    rmSync(systemDest, { recursive: true, force: true });
    renameSync(join(staging, 'system'), systemDest);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Seed-path remote fallback for applyHomeSeed: resolve the skeleton on the
 * platform's release channel, download it, and stage the FULL tree, returning
 * that path. Mirrors seedUiBuild's local-or-download model so a packaged binary
 * never asks the user to `npm install @openpalm/skeleton` by hand. The caller
 * owns cleanup of the returned staging dir.
 */
async function fetchRemoteSkeleton(repoRef: string, dataDir: string): Promise<string> {
  const channel  = uiUpdateChannel(repoRef);
  const ref      = await resolveChannelRef(SKELETON_PACKAGE, channel);
  const manifest = await fetchNpmSkeletonManifest(ref);
  logger.debug('fetching @openpalm/skeleton from npm for cold-start seed', { version: manifest.version, channel });
  return stageSkeletonDownload(manifest, dataDir);
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
  const systemDir = join(homeDir, 'system');
  return checkAndUpdateNpmBundle<NpmSkeletonManifest, SkeletonUpdateResult>({
    appVersion,
    logLabel: 'skeleton',
    resolveManifest: async () =>
      fetchNpmSkeletonManifest(await resolveChannelRef(SKELETON_PACKAGE, uiUpdateChannel(appVersion, channelOverride))),
    readCurrentVersion: () => readSkeletonVersion(homeDir),
    backup: { dir: systemDir, gate: systemDir, prefix: 'skeleton' },
    install: (manifest) => downloadNpmSkeletonBundle(manifest, homeDir, dataDir),
    // Stamp the exact npm version (bare, no `v`) so future checks compare correctly.
    afterInstall: (manifest) => {
      writeFileSync(join(homeDir, SKELETON_VERSION_STAMP), `${normalizeVersion(manifest.version)}\n`);
    },
    // The skeleton restores its own backup on failure so OP_HOME/system/ is left
    // in its previous working state (§6) — there is no supervisor to hand it to.
    restoreOnFailure: true,
    onBlockedMajor: (latestVersion) => ({ updated: false, latestVersion }),
    onUpToDate: (latestVersion) => ({ updated: false, latestVersion }),
    onSuccess: (latestVersion) => ({ updated: true, latestVersion }),
    onError: (error) => ({ updated: false, latestVersion: null, error }),
  });
}
