import { cpSync, type Dirent, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveBackupsDirFor } from "./home.js";

export function timestampDirName(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Recursively sum the apparent size (in bytes) of every file under `path`,
 * excluding the entire top-level `data/` directory — mirroring
 * {@link backupOpenPalmHome}'s own copy scope, which skips the whole `data`
 * entry (not just `data/backups`) because it is large, regenerable runtime
 * state that is never copied into a safety snapshot. Estimating more than
 * that would make the space guard refuse legitimate backups whenever `data/`
 * happens to be large, even though that size is never actually written.
 *
 * Cheap enough for a pre-backup estimate; errors on individual entries are
 * skipped (a transient unreadable file should not block the safety copy).
 */
export function estimateHomeBackupBytes(homeDir: string): number {
  if (!existsSync(homeDir)) return 0;
  let total = 0;
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (dir === homeDir && (entry.name === "data" || entry.name === "cache")) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          /* skip unreadable entries */
        }
      }
    }
  };
  walk(homeDir);
  return total;
}

export interface BackupSpaceCheck {
  /** Estimated bytes the backup will consume. */
  estimatedBytes: number;
  /** Free bytes on the destination filesystem (Infinity when unmeasurable). */
  freeBytes: number;
  /** estimatedBytes / freeBytes (Infinity when freeBytes is 0). */
  ratio: number;
  /** True when the backup would exceed `threshold` of free space, OR the destination could not be measured (fail closed). */
  insufficient: boolean;
  /** Fraction of free space considered safe to consume (default 0.8). */
  threshold: number;
  /** True when statfs on the destination threw (unsupported fs, missing path, permission denied). */
  measurementFailed: boolean;
}

/**
 * Estimate whether a full-home backup would fit safely on disk.
 *
 * Returns a structured result; the caller decides whether to warn, block, or
 * (with explicit confirmation) proceed. This NEVER deletes anything — it only
 * measures. `threshold` is the fraction of currently-free space the backup may
 * consume before it is flagged `insufficient` (default 80%).
 *
 * `destDir` is the filesystem actually measured for free space — the backup
 * DESTINATION, which per S5 may be configured onto a different filesystem than
 * `homeDir` (see {@link resolveBackupsDirFor}). It defaults to `homeDir` for
 * back-compat with direct callers that only care about one filesystem.
 *
 * FAILS CLOSED: if the destination can't be measured (missing path,
 * unsupported fs, permission denied), `insufficient` is forced `true` — an
 * unmeasurable destination must never be treated as "unlimited space", which
 * was the previous (unsafe) behavior and the reason this guard was dead code.
 */
export function checkBackupFreeSpace(homeDir: string, threshold = 0.8, destDir: string = homeDir): BackupSpaceCheck {
  const estimatedBytes = estimateHomeBackupBytes(homeDir);
  let freeBytes = Number.POSITIVE_INFINITY;
  let measurementFailed = false;
  try {
    const stat = statfsSync(destDir);
    freeBytes = stat.bavail * stat.bsize;
  } catch {
    measurementFailed = true;
  }
  const ratio = freeBytes > 0 ? estimatedBytes / freeBytes : Number.POSITIVE_INFINITY;
  return {
    estimatedBytes,
    freeBytes,
    ratio,
    insufficient: measurementFailed || estimatedBytes > freeBytes * threshold,
    threshold,
    measurementFailed,
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Human-readable, plain-language explanation of a low-free-space situation,
 * suitable for a CLI warning or a UI notice.
 */
export function describeBackupSpaceShortfall(check: BackupSpaceCheck): string {
  return (
    `The safety backup is estimated at ${formatBytes(check.estimatedBytes)}, but only ` +
    `${formatBytes(check.freeBytes)} is free on this disk. Backing up could fill the disk. ` +
    `Free up space (your old backups are under data/backups/ — review them with ` +
    `\`openpalm backups list\`), or re-run with confirmation to proceed anyway. ` +
    `Nothing was changed or deleted.`
  );
}

/** Hidden prefix for an in-progress backup — never a valid final backup name, so listBackupDirs/pruneBackupDirs skip it. */
const BACKUP_STAGING_PREFIX = ".staging-";
/** Written inside a staged backup right before the atomic rename into place; its presence is not load-bearing for listing (rename is the visibility gate), only informational. */
export const BACKUP_COMPLETE_MARKER = ".backup-complete";

/** Walk up from `path` to the nearest ancestor that exists, without creating anything. Used to statfs a not-yet-created destination without mutating the filesystem before the space guard runs. */
function nearestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/** Best-effort cleanup of staging dirs orphaned by a crash between mkdir and rename (the in-call failure path cleans up its own staging dir directly). Never throws. */
function cleanupStaleStaging(destRoot: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(destRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(BACKUP_STAGING_PREFIX)) {
      rmSync(join(destRoot, entry.name), { recursive: true, force: true });
    }
  }
}

export interface BackupOpenPalmHomeOptions {
  /** Fraction of destination free space the backup may consume before it's refused (default 0.8, see {@link checkBackupFreeSpace}). */
  threshold?: number;
  /**
   * Test seam: override the per-entry copy primitive (defaults to `fs.cpSync`).
   * Lets tests deterministically simulate a mid-copy failure without mocking
   * `node:fs` globally.
   */
  copyEntry?: (source: string, target: string) => void;
}

/**
 * Create a durable backup snapshot of the current OP_HOME contents.
 *
 * The backup is written under the configured backup destination (default
 * `OP_HOME/data/backups/<timestamp>/`, see {@link resolveBackupsDirFor}) and
 * captures the user/config/state trees (config/, system/, state/, knowledge/)
 * that a destructive operation (e.g. `install --force`) could clobber.
 *
 * The whole `data/` tree is intentionally EXCLUDED: it is large, regenerable
 * runtime state. `data/assistant` (node_modules, caches, opencode SQLite) is
 * GBs and re-created/re-downloaded on container boot. `data/guardian` and
 * `data/guardian/tools` hold guardian $HOME runtime state (nonce/rate-limit
 * store, OpenCode auth/config) plus operator-editable tool packages — small,
 * but still regenerable (the guardian's own code is baked into the image, not
 * installed under `data/guardian`; see containers/guardian/Dockerfile). Either
 * way, snapshotting `data/` buys nothing for recovery (the rollback/restore
 * path never reads these snapshots) and previously filled the disk (~5 GB per
 * snapshot).
 *
 * Atomicity: every entry is copied into a hidden `.staging-<timestamp>` dir
 * first; only on full success is a completion marker written and the staging
 * dir atomically renamed to its final, visible name. A failure partway
 * through (or a throw from the space guard before any copy starts) never
 * leaves a torn directory at the name callers expect.
 */
export function backupOpenPalmHome(homeDir: string, options: BackupOpenPalmHomeOptions = {}): string | null {
  if (!existsSync(homeDir)) return null;

  const destRoot = resolveBackupsDirFor(homeDir);
  const threshold = options.threshold ?? 0.8;

  // Wire the space guard BEFORE any mutation: measure the DESTINATION
  // filesystem (which per S5 may be a configured external mount, not
  // homeDir's own fs). Measuring via the nearest existing ancestor means we
  // don't have to mkdir the destination just to statfs it. Fail closed —
  // checkBackupFreeSpace already forces `insufficient` when unmeasurable.
  const spaceCheck = checkBackupFreeSpace(homeDir, threshold, nearestExistingAncestor(destRoot));
  if (spaceCheck.insufficient) {
    throw new Error(describeBackupSpaceShortfall(spaceCheck));
  }

  mkdirSync(destRoot, { recursive: true });
  cleanupStaleStaging(destRoot);

  const name = timestampDirName();
  const stagingDir = join(destRoot, `${BACKUP_STAGING_PREFIX}${name}`);
  const finalDir = join(destRoot, name);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  const copyEntry = options.copyEntry ?? ((source: string, target: string) => cpSync(source, target, { recursive: true }));

  let copiedAny = false;
  try {
    for (const entry of readdirSync(homeDir, { withFileTypes: true })) {
      // `data` is large regenerable runtime state; `cache` (S1) is purely
      // regenerable by definition. Copying either would re-create the
      // multi-GB snapshots #581 AC4 exists to prevent.
      if (entry.name === "data" || entry.name === "cache") continue;
      copyEntry(join(homeDir, entry.name), join(stagingDir, entry.name));
      copiedAny = true;
    }
  } catch (err) {
    // Torn-copy cleanup: never leave a partially-populated dir behind, staged
    // or (since we only rename below, on full success) final.
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }

  if (!copiedAny) {
    rmSync(stagingDir, { recursive: true, force: true });
    return null;
  }

  // Completion marker + atomic rename: the backup only becomes visible under
  // its final name in one filesystem operation, once everything has copied
  // successfully. A crash before this point leaves only a hidden `.staging-`
  // dir (cleaned up by the next call's cleanupStaleStaging, or manually) —
  // never a half-written directory at the name callers/listBackupDirs expect.
  writeFileSync(join(stagingDir, BACKUP_COMPLETE_MARKER), new Date().toISOString());
  renameSync(stagingDir, finalDir);
  return finalDir;
}

function mtimeMsOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function listBackupDirs(homeDir: string): string[] {
  const backupsDir = resolveBackupsDirFor(homeDir);
  if (!existsSync(backupsDir)) return [];

  return readdirSync(backupsDir, { withFileTypes: true })
    // Dot-prefixed entries are never a finished backup (staging dirs use
    // BACKUP_STAGING_PREFIX; guard against any other hidden dir too).
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(backupsDir, entry.name))
    // Prune/list by RECENCY, not name: a mixed namespace (plain timestamp vs
    // ui-*/skeleton-* prefixed) does not sort chronologically as strings. Ties
    // (mtime resolution is often coarser than backups can be created apart,
    // e.g. in a fast test loop or a burst of rapid snapshots) fall back to
    // name descending, which happens to agree with creation order for both
    // naming schemes actually in use (`<ISO-timestamp>` and `<prefix>-<epoch-ms>`).
    .sort((a, b) => mtimeMsOf(b) - mtimeMsOf(a) || b.localeCompare(a));
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += statSync(full).size;
      } catch {
        /* skip */
      }
    }
  }
  return total;
}

export interface BackupEntry {
  /** Absolute path of the backup snapshot directory. */
  path: string;
  /** Directory (timestamp) name. */
  name: string;
  /** Total size in bytes. */
  sizeBytes: number;
  /** ISO mtime of the snapshot directory. */
  createdAt: string;
}

export interface BackupSummary {
  count: number;
  totalBytes: number;
  /** ISO mtime of the newest backup, or null when there are none. */
  lastBackupAt: string | null;
  /** Newest-first list of backups with sizes. */
  backups: BackupEntry[];
}

/**
 * Summarize the upgrade backup snapshots for UI visibility (count, total size,
 * last-backup time, per-backup sizes). Read-only — never deletes anything.
 */
export function summarizeBackups(homeDir: string): BackupSummary {
  const dirs = listBackupDirs(homeDir); // already newest-first
  const backups: BackupEntry[] = dirs.map((path) => {
    let createdAt = "";
    try {
      createdAt = statSync(path).mtime.toISOString();
    } catch {
      /* leave empty */
    }
    return {
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      sizeBytes: dirSizeBytes(path),
      createdAt,
    };
  });
  const totalBytes = backups.reduce((sum, b) => sum + b.sizeBytes, 0);
  return {
    count: backups.length,
    totalBytes,
    lastBackupAt: backups[0]?.createdAt || null,
    backups,
  };
}

/**
 * `-pre-rollback`/`-pre-update` suffixed backups are safety snapshots taken
 * right before a destructive restore/upgrade — they may be the only surviving
 * copy of data lost elsewhere (a stripped secret value, a clobbered
 * moderation.md edit). Pruning must never touch them, regardless of the
 * `keep` count or how old they are.
 */
function isProtectedRecoveryBackup(dirPath: string): boolean {
  return /-pre-(rollback|update)$/.test(dirPath);
}

/**
 * The distinct backup namespaces sharing one `data/backups/` (or configured
 * external) directory: plain timestamp safety snapshots (`backupOpenPalmHome`,
 * `-pre-rollback`/`-pre-update`), and the host-side hot-swap prefixes written
 * by host-assets-updater.ts (`ui-*`, `skeleton-*`). Retention is per-namespace —
 * a burst of one type must never evict another type's snapshots, and mixing
 * them under one lexicographic/global cutoff is exactly the bug this fixes.
 */
export type BackupNamespace = "timestamp" | "ui" | "skeleton";

function backupNamespace(dirPath: string): BackupNamespace {
  const name = dirPath.slice(dirPath.lastIndexOf("/") + 1);
  if (name.startsWith("ui-")) return "ui";
  if (name.startsWith("skeleton-")) return "skeleton";
  return "timestamp";
}

/**
 * Keep the `keep` most-recent (by mtime) backups PER NAMESPACE, deleting the
 * rest — except `-pre-rollback`/`-pre-update` safety snapshots, which are
 * never touched. Applying retention per-namespace (rather than one global
 * newest-N cut across mixed prefixes) is what actually prunes `ui-*`/
 * `skeleton-*` host-updater snapshots instead of leaving them to accumulate
 * unbounded or evicting them out of turn against unrelated timestamp backups.
 */
export function planBackupPrune(
  homeDir: string,
  keep: number,
  namespace?: BackupNamespace,
): { toDelete: string[]; protected: string[] } {
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error('keep must be a non-negative integer');
  }

  const all = listBackupDirs(homeDir);
  const protectedDirs = all.filter(isProtectedRecoveryBackup);
  const prunable = all.filter((dir) => !isProtectedRecoveryBackup(dir));

  const byNamespace = new Map<BackupNamespace, string[]>();
  for (const dir of prunable) {
    const ns = backupNamespace(dir);
    if (namespace && ns !== namespace) continue;
    const list = byNamespace.get(ns);
    if (list) {
      list.push(dir);
    } else {
      byNamespace.set(ns, [dir]);
    }
  }

  const toDelete: string[] = [];
  for (const dirs of byNamespace.values()) {
    // `dirs` inherits listBackupDirs' newest-first (mtime) order.
    toDelete.push(...dirs.slice(keep));
  }
  return { toDelete, protected: protectedDirs };
}

export function pruneBackupDirs(homeDir: string, keep: number): string[] {
  const { toDelete } = planBackupPrune(homeDir, keep);
  for (const backupDir of toDelete) {
    rmSync(backupDir, { recursive: true, force: true });
  }
  return toDelete;
}

/**
 * Prune ONE namespace to its newest `keep`. Used by the host-side hot-swap
 * updater to bound its own `ui-*`/`skeleton-*` snapshots without ever touching
 * an operator's timestamp backups or a protected recovery snapshot.
 */
export function pruneBackupNamespace(
  homeDir: string,
  namespace: BackupNamespace,
  keep: number,
): string[] {
  const { toDelete } = planBackupPrune(homeDir, keep, namespace);
  for (const backupDir of toDelete) {
    rmSync(backupDir, { recursive: true, force: true });
  }
  return toDelete;
}
