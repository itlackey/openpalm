import { closeSync, cpSync, type Dirent, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { actionableOwnershipError } from "./errors.js";
import { OP_HOME_TREES, resolveBackupsDirFor, stateEnvDir } from "./home.js";
import { createLogger } from "../logger.js";

const logger = createLogger("lib:backup");

export function timestampDirName(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * The top-level trees a safety snapshot never copies, derived from the ONE
 * tree manifest (#656 / lesson 24) instead of a hand-maintained denylist that
 * drifted from it — `workspace/` was missing here even though its docblock
 * never claimed to cover it, so a cloned repo's `.git/` under workspace/ was
 * copied into every snapshot (#648). `data/` is large, regenerable service
 * state; `cache/` (S1) is regenerable by definition; `workspace/` is the
 * operator's own regenerable work area. Copying any of them re-creates the
 * multi-GB snapshots #581 AC4 / #648 exist to prevent.
 */
const UNBACKED_TOP_LEVEL: ReadonlySet<string> = new Set(
  OP_HOME_TREES.filter((tree) => !tree.inBackup).map((tree) => tree.name),
);

/** What a safety snapshot copies, and what it deliberately leaves out. */
export interface BackupScope {
  /** True when `path` (absolute, inside the home) belongs in the snapshot. */
  includes(path: string): boolean;
  /**
   * Absolute paths left out because the service they belong to is out of scope
   * — recorded so the snapshot can name them (constitution §5).
   */
  skippedCredentials: string[];
}

/**
 * THE backup scope, resolved once per snapshot and shared by the copy and the
 * estimator. Two hand-mirrored denylists is how the space guard and the copy
 * scope drifted apart before (G6); there is one definition here instead.
 *
 * §5 — a service's data and its credentials are ONE restore unit: a snapshot
 * takes both or neither. `data/<svc>` is out of scope, so `<svc>`'s credentials
 * are too. Restoring only the credentials is the G5 trap: Paperclip's
 * `BETTER_AUTH_SECRET` back without `data/paperclip` yields a working login
 * against an empty database, and the operator reads that as a successful
 * restore. Both halves now leave together, and the documented per-service
 * procedure (docs/backup-restore.md) takes them together.
 *
 * The pairing key is the SERVICE NAME, derived — not listed. `state/env/<svc>.env`
 * is the only credential artifact named after a service, so it is the only one
 * that can be paired with a `data/<svc>` tree without a hand-maintained map
 * (lesson 24). `state/secrets/` holds control-plane credentials named by ROLE,
 * several of them shared across services, and each is an INPUT its service's
 * `data/` tree is derived from (a tailnet auth key, an admin token) rather than
 * something that authenticates existing rows — nothing there pairs, and it all
 * stays in scope.
 */
export function resolveBackupScope(homeDir: string): BackupScope {
  let services: string[] = [];
  try {
    services = readdirSync(join(homeDir, "data"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    /* no data/ tree yet — nothing is out of scope by service */
  }
  const skippedCredentials = services
    .map((service) => join(stateEnvDir(homeDir), `${service}.env`))
    .filter((path) => existsSync(path));
  const skipped = new Set(skippedCredentials);

  return {
    includes(path: string): boolean {
      const rel = relative(homeDir, path);
      // Not under the home at all: not this scope's call to make.
      if (!rel || rel.startsWith("..")) return true;
      if (UNBACKED_TOP_LEVEL.has(rel.split(sep)[0])) return false;
      return !skipped.has(path);
    },
    skippedCredentials,
  };
}

/**
 * Recursively sum the apparent size (in bytes) of every file under `homeDir`
 * that {@link resolveBackupScope} includes — the same predicate
 * {@link backupOpenPalmHome} copies by, so the estimate cannot drift from what
 * is actually written. Estimating more than that would make the space guard
 * refuse legitimate backups whenever `data/` happens to be large, even though
 * that size is never written.
 *
 * Cheap enough for a pre-backup estimate; errors on individual entries are
 * skipped (a transient unreadable file should not block the safety copy).
 */
export function estimateHomeBackupBytes(homeDir: string): number {
  if (!existsSync(homeDir)) return 0;
  const scope = resolveBackupScope(homeDir);
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
      if (!scope.includes(full)) continue;
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
    `\`openpalm backups list\`), or re-run with confirmation to proceed anyway. ` + // #648: this command must exist — see backups.ts's `list` subcommand.
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

/** Streamed chunk size for {@link hashScopeContents} — bounds memory regardless of file size. */
const HASH_CHUNK_BYTES = 1 << 20; // 1 MiB

/** Stream a file's bytes into `hash` in fixed-size chunks — never buffers a whole file. */
function hashFileStreaming(hash: import("node:crypto").Hash, path: string): void {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(HASH_CHUNK_BYTES);
    for (;;) {
      const bytesRead = readSync(fd, buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Content hash of everything `scope` includes under `homeDir` (#657 pt.1).
 *
 * Path+size+mtime is NOT a content hash: a `touch`, a restore that preserves
 * mtimes, or an editor that rewrites a file byte-for-byte all change one of
 * those without changing what a restore would produce, in both directions —
 * false positives (a needless multi-GB re-copy) and false negatives (a real
 * edit missed because size and mtime happened to collide) are both live
 * risks with a metadata-only check. This hashes actual file bytes, streamed
 * in fixed chunks (see {@link hashFileStreaming}) so even a large in-scope
 * file (an operator's own `knowledge/` content) is never buffered whole.
 * Every file's relative path and content is folded into one running SHA-256,
 * NUL-delimited (POSIX paths cannot contain NUL) so no path/content boundary
 * is ambiguous, in a fixed (sorted) order so the result is deterministic
 * regardless of directory-listing order.
 */
function hashScopeContents(homeDir: string, scope: BackupScope): string {
  const hash = createHash("sha256");
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (!scope.includes(full)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(homeDir);
  files.sort();
  for (const file of files) {
    hash.update(relative(homeDir, file));
    hash.update("\0");
    try {
      hashFileStreaming(hash, file);
    } catch {
      // Unreadable (permission, or a concurrent writer removed it mid-walk):
      // hash as absent content rather than aborting the gate. If it is still
      // unreadable when the real copy runs below, that copy surfaces the
      // actionable ownership error itself.
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

const CONTENT_HASH_LINE_PREFIX = "content-hash: sha256:";

/** The content-hash line a previous {@link backupOpenPalmHome} call recorded in its `.backup-complete` marker, or null if absent/unreadable (a pre-hash-gate snapshot, or a namespace that never writes one). */
function readRecordedContentHash(backupDir: string): string | null {
  try {
    const marker = readFileSync(join(backupDir, BACKUP_COMPLETE_MARKER), "utf-8");
    const line = marker.split("\n").find((l) => l.startsWith(CONTENT_HASH_LINE_PREFIX));
    return line ? line.slice(CONTENT_HASH_LINE_PREFIX.length).trim() : null;
  } catch {
    return null;
  }
}

/**
 * The newest snapshot `backupOpenPalmHome` itself wrote — NOT the newest
 * backup dir overall. `ui-*`/`skeleton-*` are a different process with a
 * different scope and no content-hash line; `-pre-rollback` is a different
 * (partial-file) scope written by rollback.ts. Comparing the hash gate
 * against either would skip a real backup or compare hashes that were never
 * computed the same way.
 */
function newestTimestampBackupDir(homeDir: string): string | null {
  return listBackupDirs(homeDir).find((dir) => backupNamespace(dir) === "timestamp") ?? null;
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
 * snapshot). `workspace/` is excluded for the same reason: it is the
 * operator's own regenerable work area, and a cloned repo's `.git/` there
 * once made a routine upgrade copy hundreds of MB per snapshot (#648). A
 * service excluded that way loses its credentials from the snapshot too —
 * see {@link resolveBackupScope} — and the completion marker names each one,
 * so the snapshot itself says what it does not contain.
 *
 * Hash gate (#657 pt.1): before copying anything, this hashes the in-scope
 * tree's actual content ({@link hashScopeContents}) and compares it to the
 * hash the newest snapshot in this same (plain-timestamp) namespace
 * recorded. An unchanged home — the common case on a failed-then-retried
 * upgrade, which previously wrote a full undeduplicated snapshot on every
 * attempt — skips the copy entirely and returns that existing snapshot's
 * directory; a home that changed proceeds exactly as before.
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
  const scope = resolveBackupScope(homeDir);

  const contentHash = hashScopeContents(homeDir, scope);
  const previousBackup = newestTimestampBackupDir(homeDir);
  if (previousBackup && readRecordedContentHash(previousBackup) === contentHash) {
    logger.info("backup skipped: content unchanged since previous snapshot", {
      previousBackup,
      contentHash,
    });
    return previousBackup;
  }

  // Wire the space guard BEFORE any mutation: measure the DESTINATION
  // filesystem (which per S5 may be a configured external mount, not
  // homeDir's own fs). Measuring via the nearest existing ancestor means we
  // don't have to mkdir the destination just to statfs it. Fail closed —
  // checkBackupFreeSpace already forces `insufficient` when unmeasurable.
  const spaceCheck = checkBackupFreeSpace(homeDir, threshold, nearestExistingAncestor(destRoot));
  if (spaceCheck.insufficient) {
    throw new Error(describeBackupSpaceShortfall(spaceCheck));
  }

  // #641/#642, #653: a copy/rename/rm below can hit a file a prior root-owned
  // (or foreign-owned, after a host/drive swap) run left behind and surface a
  // bare `EACCES: permission denied, rm '…'`/`copyfile '…'` with no next
  // step. Map that one failure class to an actionable message naming the
  // path and the remedy; everything else still throws unchanged.
  try {
    mkdirSync(destRoot, { recursive: true });
    cleanupStaleStaging(destRoot);

    const name = timestampDirName();
    const stagingDir = join(destRoot, `${BACKUP_STAGING_PREFIX}${name}`);
    const finalDir = join(destRoot, name);
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });

    const copyEntry =
      options.copyEntry ??
      ((source: string, target: string) => cpSync(source, target, { recursive: true, filter: scope.includes }));

    let copiedAny = false;
    try {
      for (const entry of readdirSync(homeDir, { withFileTypes: true })) {
        const source = join(homeDir, entry.name);
        // The scope skips the `data`/`cache`/`workspace` trees wholesale
        // here, and prunes an excluded service's credentials from inside the
        // trees that are copied.
        if (!scope.includes(source)) continue;
        copyEntry(source, join(stagingDir, entry.name));
        copiedAny = true;
      }
    } catch (err) {
      // Torn-copy cleanup: never leave a partially-populated dir behind,
      // staged or (since we only rename below, on full success) final. Never
      // let a cleanup failure here mask the real copy error below.
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        /* best-effort; the original copy error is what gets rethrown */
      }
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
    //
    // The marker also NAMES the credentials the scope left out (§5), and
    // records the content hash the next call's hash gate compares against.
    // Whoever restores this snapshot months from now is the person who needs
    // to know that a service's login secret is not in it, and the marker
    // travels with the snapshot; a log line at backup time does not.
    writeFileSync(
      join(stagingDir, BACKUP_COMPLETE_MARKER),
      [
        new Date().toISOString(),
        `${CONTENT_HASH_LINE_PREFIX}${contentHash}`,
        ...(scope.skippedCredentials.length > 0
          ? [
              "",
              "Skipped — these belong to a service whose data/ tree is out of scope,",
              "and are restored with it (see docs/backup-restore.md):",
              ...scope.skippedCredentials.map((path) => `  ${relative(homeDir, path)}`),
            ]
          : []),
      ].join("\n"),
    );
    renameSync(stagingDir, finalDir);
    return finalDir;
  } catch (err) {
    // homeDir is the read side of every copyEntry() call above — the tree
    // that already existed and can hold a file a prior run left
    // foreign-owned; stagingDir is freshly created by this call and not the
    // realistic offender.
    throw actionableOwnershipError(err, homeDir) ?? err;
  }
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
 * `-pre-update` suffixed backups are safety snapshots taken right before a
 * destructive upgrade — they may be the only surviving copy of data lost
 * elsewhere (a stripped secret value, a clobbered moderation.md edit).
 * Pruning must never touch them, regardless of the `keep` count or how old
 * they are.
 *
 * `-pre-rollback` is deliberately NOT in this predicate (#657 pt.2): nothing
 * capped it, so a stack that keeps failing and retrying `openpalm rollback`
 * wrote an unbounded run of them. It is a normal per-namespace retention
 * bucket instead — see {@link backupNamespace} — capped the same way
 * `ui-*`/`skeleton-*` are; rollback.ts's own restoreSnapshot caps it at the
 * same N plain timestamp backups keep.
 */
function isProtectedRecoveryBackup(dirPath: string): boolean {
  return /-pre-update$/.test(dirPath);
}

/**
 * The distinct backup namespaces sharing one `data/backups/` (or configured
 * external) directory: plain timestamp safety snapshots (`backupOpenPalmHome`),
 * `-pre-rollback` (rollback.ts, capped like any other namespace — see
 * {@link isProtectedRecoveryBackup}), and the `ui-*`/`skeleton-*` namespaces.
 * Retention is per-namespace — a burst of one type must never evict another
 * type's snapshots, and mixing them under one lexicographic/global cutoff is
 * exactly the bug this fixes.
 */
export type BackupNamespace = "timestamp" | "ui" | "skeleton" | "pre-rollback";

function backupNamespace(dirPath: string): BackupNamespace {
  const name = dirPath.slice(dirPath.lastIndexOf("/") + 1);
  if (name.startsWith("ui-")) return "ui";
  if (name.startsWith("skeleton-")) return "skeleton";
  if (name.endsWith("-pre-rollback")) return "pre-rollback";
  return "timestamp";
}

/**
 * Keep the `keep` most-recent (by mtime) backups PER NAMESPACE, deleting the
 * rest — except `-pre-update` safety snapshots, which are never touched (see
 * {@link isProtectedRecoveryBackup}). Applying retention per-namespace
 * (rather than one global newest-N cut across mixed prefixes) is what
 * actually prunes `ui-*`/`skeleton-*`/`-pre-rollback` snapshots on their own
 * terms instead of leaving them to accumulate unbounded or evicting them out
 * of turn against unrelated timestamp backups.
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

export function pruneBackupDirs(homeDir: string, keep: number, namespace?: BackupNamespace): string[] {
  const { toDelete } = planBackupPrune(homeDir, keep, namespace);
  for (const backupDir of toDelete) {
    rmSync(backupDir, { recursive: true, force: true });
  }
  return toDelete;
}
