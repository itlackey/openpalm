/**
 * Runtime asset seeding and resolution for the `@openpalm/client` static app —
 * a THIN SIBLING of ui-assets.ts (plan ui-runtime-modes-plan.md Phase 5 item 3,
 * #555). Same channel/verify/stage/swap/backup pipeline via npm-bundle-updater;
 * only the policy knobs differ.
 *
 * The client artifact keeps the npm package's root shape on disk:
 *
 *   <root>/build/          adapter-static bundle (gate file: index.html; the
 *                          build script stamps build/.openpalm-client-version)
 *   <root>/bin/serve.mjs   the zero-dependency static server the harness spawns
 *
 * Channels:
 *   data channel  → OP_HOME/data/client/{build,bin}   (operator-updatable)
 *   dev override  → $OPENPALM_REPO_ROOT/packages/client/{build,bin}
 *
 * The serve script travels WITH the updatable artifact so a compiled CLI binary
 * can run it in every channel: `join(buildDir, '..', 'bin', 'serve.mjs')` holds
 * for both.
 *
 * Unlike the UI there is NO harness-contract gate: the client is a static
 * bundle served over plain HTTP — it has no native bridge to outgrow (§8.10:
 * it never bundles @openpalm/lib and never holds host credentials).
 *
 * Node.js-compatible only (no Bun.* APIs) — consumed by the CLI and Electron.
 */
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDataDir } from './home.js';
import { createLogger } from '../logger.js';
import { compareComparableVersions, normalizeVersion } from './versioning.js';
import {
  NPM_REGISTRY,
  fetchWithRetry,
  stageNpmBundle,
  checkAndUpdateNpmBundle,
  type NpmBundleManifest,
} from './npm-bundle-updater.js';
import { copyTree, resolveChannelRef, uiUpdateChannel, type UiUpdateChannel } from './ui-assets.js';

const logger = createLogger('lib:client-assets');

const CLIENT_PACKAGE = '@openpalm/client';

/**
 * Filename of the build-time version stamp written into the client build root
 * by packages/client/scripts/stamp-version.mjs — a cross-package contract: the
 * stamp travels with the static bundle wherever it is copied/extracted.
 */
export const CLIENT_VERSION_STAMP = '.openpalm-client-version';

/** Read the stamped client version from a build dir, or null if absent/unreadable. */
export function readClientBuildVersion(dir: string): string | null {
  try {
    const v = readFileSync(join(dir, CLIENT_VERSION_STAMP), 'utf-8').trim();
    return v || null;
  } catch {
    return null;
  }
}

/** The data-channel package root (OP_HOME/data/client — holds build/ + bin/). */
function dataClientRoot(): string {
  return join(resolveDataDir(), 'client');
}

/**
 * Locate a bundled/local client build on disk (mirrors resolveLocalUiBuild).
 * Returns null when not found — triggers the npm download in seedClientBuild.
 */
export function resolveLocalClientBuild(): string | null {
  const strategies: Array<() => string | null> = [
    // 1. Explicit dev override — OPENPALM_REPO_ROOT points to the repo root.
    () => process.env.OPENPALM_REPO_ROOT
      ? join(process.env.OPENPALM_REPO_ROOT, 'packages', 'client', 'build')
      : null,
    // 2. Electron extraResources — client-build/ placed alongside the asar.
    () => {
      const rp = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
      if (!rp) return null;
      return join(rp, 'client-build');
    },
    // 3. Relative to this source file (dev / bun run).
    () => {
      const meta = fileURLToPath(import.meta.url);
      if (meta.startsWith('/$bunfs/')) return null;
      const candidate = join(dirname(meta), '..', '..', '..', '..', 'packages', 'client', 'build');
      return existsSync(join(candidate, 'index.html')) ? candidate : null;
    },
    // 4. Relative to compiled binary / Electron executable.
    () => {
      const binDir = dirname(realpathSync(process.execPath));
      const candidate = join(binDir, '..', '..', '..', 'packages', 'client', 'build');
      return existsSync(join(candidate, 'index.html')) ? candidate : null;
    },
  ];
  for (const strategy of strategies) {
    try {
      const p = strategy();
      if (p && existsSync(p)) return p;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Resolve which client build to serve — the BUILD dir (…/client/build), with
 * the same version-aware two-channel selection as resolveUiBuildDir: when both
 * channels hold a build, data/client wins ONLY when it is strictly newer per
 * the version stamp; an unstamped/older data/client never shadows a newer
 * bundled build. Falls back to the data path when nothing is present (the
 * caller seeds).
 */
export function resolveClientBuildDir(): string {
  const dataBuild = join(dataClientRoot(), 'build');
  const hasData = existsSync(join(dataBuild, 'index.html'));
  // resolveLocalClientBuild()'s env/resourcesPath candidates only check the dir
  // exists, not that it holds a servable build — require index.html before
  // trusting it (same gate as resolveUiBuildDir).
  const bundledRaw = resolveLocalClientBuild();
  const bundled = bundledRaw && existsSync(join(bundledRaw, 'index.html')) ? bundledRaw : null;

  if (hasData && bundled) {
    const dataVer = readClientBuildVersion(dataBuild);
    const bundledVer = readClientBuildVersion(bundled);
    // data/client wins only when we can prove it's strictly newer.
    if (dataVer && bundledVer && compareComparableVersions(dataVer, bundledVer) > 0) return dataBuild;
    // De-routed installs must be VISIBLE, never silent (same rationale as
    // resolveUiBuildDir, §6.1 Risk #1).
    if (!dataVer) {
      logger.warn('data/client present but UNSTAMPED — ignoring it and serving the bundled client build', {
        dataBuild, bundled, bundledVersion: bundledVer ?? '(unstamped)',
      });
    } else {
      logger.warn('data/client present but not strictly newer than the bundled build — serving the bundled client build', {
        dataBuild, dataVersion: dataVer, bundled, bundledVersion: bundledVer ?? '(unstamped)',
      });
    }
    return bundled;
  }
  if (hasData) return dataBuild;
  if (bundled) return bundled;
  return dataBuild; // nothing present yet → caller triggers seedClientBuild
}

/**
 * Resolve the abbreviated npm manifest for `@openpalm/client` by exact version
 * OR dist-tag. Throws on non-OK. No minHarnessContract field — the client has
 * no native bridge (contrast fetchNpmUiManifest).
 */
async function fetchNpmClientManifest(versionOrTag: string): Promise<NpmBundleManifest> {
  const url = `${NPM_REGISTRY}/${CLIENT_PACKAGE}/${versionOrTag}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`npm registry returned HTTP ${res.status} for ${CLIENT_PACKAGE}@${versionOrTag}`);
  const m = await res.json() as { version?: string; dist?: { tarball?: string; integrity?: string } };
  if (!m.version || !m.dist?.tarball) {
    throw new Error(`npm manifest for ${CLIENT_PACKAGE}@${versionOrTag} is missing version/dist.tarball`);
  }
  return { version: m.version, tarball: m.dist.tarball, integrity: m.dist.integrity ?? null };
}

/**
 * Download `@openpalm/client`'s npm tarball, verify integrity (fail-closed via
 * stageNpmBundle), and swap BOTH published trees — `build/` and `bin/` — into
 * the client package root. npm wraps the package under `package/` and we
 * publish `files: ["build", "bin"]`, so strip 1 component and keep exactly
 * those two subtrees. The shipped stamp (build/.openpalm-client-version) is
 * kept as-is — no afterInstall re-stamp needed (same as the UI build).
 */
async function downloadNpmClientBundle(manifest: NpmBundleManifest, clientRoot: string, dataDir: string): Promise<void> {
  const staging = await stageNpmBundle(manifest, dataDir, {
    packageName: CLIENT_PACKAGE,
    label: 'client',
    tmpTarName: '.client.tgz.tmp',
    stagingName: '.client.staging',
    strip: 1,
    filter: (p) => p.startsWith('package/build/') || p.startsWith('package/bin/'),
    validate: (s) => {
      if (!existsSync(join(s, 'build', 'index.html'))) {
        throw new Error('downloaded client bundle is missing build/index.html');
      }
      if (!existsSync(join(s, 'bin', 'serve.mjs'))) {
        throw new Error('downloaded client bundle is missing bin/serve.mjs');
      }
    },
  });
  try {
    // Swap: the staged root IS the artifact — remove the live root and move it in.
    rmSync(clientRoot, { recursive: true, force: true });
    renameSync(staging, clientRoot);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Install the client artifact to OP_HOME/data/client/ ({build,bin}).
 *
 * Copies from the local/bundled `packages/client/` when available — BOTH the
 * build and the sibling bin/serve.mjs, because the CLI runs
 * data/client/bin/serve.mjs and a compiled binary has no other copy — otherwise
 * downloads the `@openpalm/client` bundle from npm (integrity fail-closed).
 * No harness-contract gate: the client is a static bundle (see module doc).
 */
export async function seedClientBuild(
  repoRef: string,
  dataDir: string,
  options?: { forceRemote?: boolean },
): Promise<void> {
  const clientRoot = join(dataDir, 'client');

  const local = options?.forceRemote ? null : resolveLocalClientBuild();
  if (local) {
    logger.debug('seeding client build from local source', { src: local });
    mkdirSync(clientRoot, { recursive: true });
    copyTree(local, join(clientRoot, 'build'));
    // The serve script lives beside the build in the source/package layout
    // (packages/client/bin/serve.mjs) — it must travel with the seeded artifact.
    copyTree(join(local, '..', 'bin'), join(clientRoot, 'bin'));
    if (!readClientBuildVersion(join(clientRoot, 'build'))) {
      logger.warn('seeded client build has no version stamp — auto-update comparison will be unreliable', { src: local });
    }
    return;
  }

  // normalizeVersion strips a leading 'v' so a release ref (v1.2.3) becomes the
  // npm version (1.2.3); dist-tags (latest/next) pass through unchanged.
  const manifest = await fetchNpmClientManifest(normalizeVersion(repoRef));
  logger.debug('downloading client build from npm', { version: manifest.version });
  await downloadNpmClientBundle(manifest, clientRoot, dataDir);
}

// ── Client update check ──────────────────────────────────────────────────────

export interface ClientBuildUpdateResult {
  updated: boolean;
  latestVersion: string | null;
  error?: string;
  /**
   * The on-disk backup of the PREVIOUS client artifact (data/backups/client-<ts>,
   * capturing the package root: build/ + bin/). Present only when `updated` is
   * true and a prior artifact existed — kept so a supervisor can restore it if
   * the new build fails to serve.
   */
  backupDir?: string;
}

/**
 * Check npm for a newer `@openpalm/client` build and apply it if one exists.
 *
 * `@openpalm/client` is independently versioned (like `@openpalm/ui`): pick the
 * dist-tag CHANNEL from the app's release stream (prerelease → newest across
 * all dist-tags, stable → `latest`) and compare against the version stamped in
 * the RESOLVED build on disk. Never auto-crosses a major version.
 *
 * When an update is available:
 *   1. Move data/client/ → data/backups/client-{timestamp}/ (build + bin)
 *   2. Download the npm bundle (integrity fail-closed) and swap it in
 *
 * Non-fatal: any network or extraction error returns { updated: false, error }.
 * On a failed install the backup is restored in place (restoreOnFailure) —
 * unlike the UI there is no supervisor restore hook wired for the client, so
 * the artifact must never be left missing.
 */
export async function checkAndUpdateClientBuild(
  appVersion: string,
  dataDir: string,
  channelOverride?: UiUpdateChannel,
): Promise<ClientBuildUpdateResult> {
  const clientRoot = join(dataDir, 'client');
  return checkAndUpdateNpmBundle<NpmBundleManifest, ClientBuildUpdateResult>({
    appVersion,
    logLabel: 'client build',
    resolveManifest: async () =>
      fetchNpmClientManifest(await resolveChannelRef(CLIENT_PACKAGE, uiUpdateChannel(appVersion, channelOverride))),
    // Compare against the client build currently on disk, NOT the app version —
    // the client floats on its own version line. The app version is only the
    // fallback major-version guard when the on-disk build is unstamped.
    readCurrentVersion: () => readClientBuildVersion(resolveClientBuildDir()),
    backup: { dir: clientRoot, gate: join(clientRoot, 'build', 'index.html'), prefix: 'client' },
    install: (manifest) => downloadNpmClientBundle(manifest, clientRoot, dataDir),
    restoreOnFailure: true,
    onBlockedMajor: (latestVersion) => ({ updated: false, latestVersion }),
    onUpToDate: (latestVersion) => ({ updated: false, latestVersion }),
    onSuccess: (latestVersion, backupDir) => ({ updated: true, latestVersion, backupDir }),
    onError: (error) => ({ updated: false, latestVersion: null, error }),
  });
}
