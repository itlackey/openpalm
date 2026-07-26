/**
 * Generic npm-tarball download / verify / stage / swap engine.
 *
 * The UI build (`@openpalm/ui`) and the OP_HOME skeleton (`@openpalm/skeleton`)
 * are both independently-versioned npm packages the control plane hot-swaps at
 * runtime through the SAME pipeline: resolve a channel/version, fetch the
 * registry manifest, download the tarball, verify its sha512 integrity
 * (fail-closed), extract into a staging dir, validate, then atomically swap it
 * into place — backing up the previous copy first. The two flows diverge only
 * in a handful of policy knobs (strip depth, tarball filter, staging validation,
 * the swap destination, the version stamp, the harness-contract gate, and
 * restore-on-failure vs. return-the-backup). This module captures the shared
 * mechanics; ui-assets.ts instantiates it twice with those knobs as parameters.
 *
 * Node.js-compatible only (no Bun.* APIs) — consumed by the CLI and Electron.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { errMessage } from './errors.js';
import { retry } from './retry.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { x as tarExtract } from 'tar';
import { resolveBackupsDir } from './home.js';
import { createLogger } from '../logger.js';
import { compareComparableVersions, isSameMajorVersion } from './versioning.js';

const logger = createLogger('lib:npm-bundle');

export const NPM_REGISTRY = 'https://registry.npmjs.org';

/** The abbreviated npm manifest fields every bundle flow needs. */
export interface NpmBundleManifest {
  version: string;
  tarball: string;
  /** Subresource-integrity string ("sha512-<base64>"); null if the registry omitted it. */
  integrity: string | null;
}

/**
 * Fetch a URL with bounded retries. Retries on network error or 5xx; a 4xx is
 * returned as-is (the caller decides). Throws only after exhausting retries.
 */
export async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  // Exponential backoff between attempts (200ms, 400ms, …), no wait before the first.
  const delays = Array.from({ length: retries }, (_, i) => (i === 0 ? 0 : 200 * 2 ** (i - 1)));
  return retry(async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    // A 4xx (or any <500) is returned as-is; a 5xx is a retryable failure.
    if (res.ok || res.status < 500) return res;
    throw new Error(`Failed to fetch ${url} after ${retries} attempts`);
  }, { delays });
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

/** Per-package knobs for {@link stageNpmBundle}. */
export interface StageBundleOptions {
  /** Package coordinate, for the fail-closed error message. */
  packageName: string;
  /** Human noun used in log/error copy ("UI" / "skeleton"). */
  label: string;
  /** Temp tarball filename written under dataDir. */
  tmpTarName: string;
  /** Staging dir name written under dataDir. */
  stagingName: string;
  /** tar `strip` component count (npm wraps under `package/`). */
  strip: number;
  /** Optional tar entry filter (e.g. only `package/build/`). */
  filter?: (path: string) => boolean;
  /** Throw if the extracted staging dir is not a valid bundle. */
  validate: (stagingDir: string) => void;
}

/**
 * Download `manifest.tarball`, verify its integrity fail-closed, extract it into
 * a fresh staging dir under `dataDir`, validate, and RETURN the staging path.
 *
 * The caller owns the staging dir on success (swap it into place, then remove
 * it). On any failure the staging dir is removed and the error rethrown; the
 * temp tarball is always cleaned up.
 */
export async function stageNpmBundle(
  manifest: NpmBundleManifest,
  dataDir: string,
  opts: StageBundleOptions,
): Promise<string> {
  const res = await fetchWithRetry(manifest.tarball);
  if (!res.ok) throw new Error(`Failed to download ${opts.label} bundle (HTTP ${res.status})`);
  const data = new Uint8Array(await res.arrayBuffer());

  // Verify BEFORE touching anything. Fail closed: a missing hash is treated as a
  // verification failure, not a warning — modern npm always supplies dist.integrity,
  // so its absence means a non-canonical/altered registry response.
  if (!manifest.integrity) {
    throw new Error(`npm manifest for ${opts.packageName}@${manifest.version} has no integrity hash — refusing to install unverified`);
  }
  verifyNpmIntegrity(data, manifest.integrity);
  logger.debug(`${opts.label} bundle integrity verified`, { version: manifest.version });

  const tmpTar  = join(dataDir, opts.tmpTarName);
  const staging = join(dataDir, opts.stagingName);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    writeFileSync(tmpTar, data);
    await tarExtract({
      file: tmpTar,
      cwd: staging,
      strip: opts.strip,
      ...(opts.filter ? { filter: opts.filter } : {}),
    });
    opts.validate(staging);
    return staging;
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  } finally {
    rmSync(tmpTar, { force: true });
  }
}

/**
 * Orchestration knobs for {@link checkAndUpdateNpmBundle}. `M` is the concrete
 * manifest type (so package-specific fields like `minHarnessContract` stay
 * typed through the hooks); `R` is the result the caller returns.
 */
export interface CheckAndUpdateConfig<M extends NpmBundleManifest, R> {
  /** The app/platform version — the fallback policy base for an unstamped install. */
  appVersion: string;
  /** Human noun used in debug-log copy ("UI build" / "skeleton"). */
  logLabel: string;
  /** Resolve the target manifest (channel resolution + registry fetch). */
  resolveManifest: () => Promise<M>;
  /** Read the version currently on disk (null when unstamped). */
  readCurrentVersion: () => string | null;
  /**
   * Optional gate run right after the manifest is fetched, before any version
   * comparison or download (e.g. the harness-contract check). Return a result to
   * short-circuit; return null to proceed.
   */
  preflight?: (manifest: M) => R | null;
  /**
   * The live directory to back up before swapping, and the path whose existence
   * gates the backup. `prefix` names the backup dir (`<prefix>-<timestamp>`).
   */
  backup: { dir: string; gate: string; prefix: string };
  /** Download + atomically swap the new bundle into place (throws on failure). */
  install: (manifest: M) => Promise<void>;
  /** Optional post-install side effect (e.g. write the version stamp). */
  afterInstall?: (manifest: M) => void;
  /** Restore the backup into `backup.dir` on failure (vs. leaving it for a caller). */
  restoreOnFailure: boolean;
  onBlockedMajor: (latestVersion: string) => R;
  onUpToDate: (latestVersion: string) => R;
  onSuccess: (latestVersion: string, backupDir: string | undefined) => R;
  onError: (error: string, backupDir: string | undefined) => R;
}

/**
 * Shared "is there a newer bundle on our channel? if so, back up + swap it in"
 * flow. Never auto-crosses a major version. Non-fatal: any network/extraction
 * error is caught and routed through `onError` so the caller proceeds with the
 * existing bundle.
 */
export async function checkAndUpdateNpmBundle<M extends NpmBundleManifest, R>(
  cfg: CheckAndUpdateConfig<M, R>,
): Promise<R> {
  let backupDir: string | undefined;
  try {
    const manifest = await cfg.resolveManifest();
    const latestVersion = manifest.version;

    const gated = cfg.preflight?.(manifest);
    if (gated) return gated;

    const currentVersion = cfg.readCurrentVersion();
    const currentVersionForPolicy = currentVersion ?? cfg.appVersion;

    if (!isSameMajorVersion(latestVersion, currentVersionForPolicy)) {
      logger.debug(`${cfg.logLabel} update blocked by major-version policy`, {
        current: currentVersion ?? '(unstamped)',
        policyBase: currentVersionForPolicy,
        latest: latestVersion,
      });
      return cfg.onBlockedMajor(latestVersion);
    }

    if (currentVersion && compareComparableVersions(latestVersion, currentVersion) <= 0) {
      logger.debug(`${cfg.logLabel} is up to date`, { current: currentVersion, latest: latestVersion });
      return cfg.onUpToDate(latestVersion);
    }
    if (!currentVersion) {
      logger.debug(`${cfg.logLabel} is unstamped — refreshing from npm`, { latest: latestVersion });
    }

    // Back up the existing bundle before replacing it.
    if (existsSync(cfg.backup.gate)) {
      backupDir = join(resolveBackupsDir(), `${cfg.backup.prefix}-${Date.now()}`);
      mkdirSync(resolveBackupsDir(), { recursive: true });
      renameSync(cfg.backup.dir, backupDir);
      logger.debug(`backed up ${cfg.logLabel} before update`, { backup: backupDir });
    }

    await cfg.install(manifest);
    cfg.afterInstall?.(manifest);
    logger.debug(`${cfg.logLabel} updated`, { from: currentVersion ?? '(unstamped)', to: latestVersion });

    return cfg.onSuccess(latestVersion, backupDir);
  } catch (err) {
    const error = errMessage(err);
    logger.debug(`${cfg.logLabel} update check failed (non-fatal)`, { error });
    // Restore-on-failure flows (skeleton) put the previous tree back if the
    // backup was taken before the download threw; return-the-backup flows (UI)
    // hand `backupDir` back so a supervisor can restore later.
    if (cfg.restoreOnFailure && backupDir && !existsSync(cfg.backup.dir)) {
      try {
        renameSync(backupDir, cfg.backup.dir);
        logger.debug(`${cfg.logLabel} backup restored after failed update`, { restored: backupDir });
      } catch (restoreErr) {
        logger.debug(`${cfg.logLabel} backup restore also failed`, {
          backup: backupDir,
          restoreError: errMessage(restoreErr),
        });
      }
    }
    return cfg.onError(error, backupDir);
  }
}
