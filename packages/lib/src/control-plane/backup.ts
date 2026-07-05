import { cpSync, type Dirent, existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";

export function timestampDirName(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Recursively sum the apparent size (in bytes) of every file under `path`,
 * excluding the existing backups directory (we never back up backups).
 *
 * Cheap enough for a pre-backup estimate; errors on individual entries are
 * skipped (a transient unreadable file should not block the safety copy).
 */
export function estimateHomeBackupBytes(homeDir: string): number {
  if (!existsSync(homeDir)) return 0;
  const backupsDir = join(homeDir, "data", "backups");
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
      if (full === backupsDir) continue;
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
  /** Free bytes on the filesystem backing OP_HOME. */
  freeBytes: number;
  /** estimatedBytes / freeBytes (Infinity when freeBytes is 0). */
  ratio: number;
  /** True when the backup would exceed `threshold` of free space. */
  insufficient: boolean;
  /** Fraction of free space considered safe to consume (default 0.8). */
  threshold: number;
}

/**
 * Estimate whether a full-home backup would fit safely on disk.
 *
 * Returns a structured result; the caller decides whether to warn, block, or
 * (with explicit confirmation) proceed. This NEVER deletes anything — it only
 * measures. `threshold` is the fraction of currently-free space the backup may
 * consume before it is flagged `insufficient` (default 80%).
 */
export function checkBackupFreeSpace(homeDir: string, threshold = 0.8): BackupSpaceCheck {
  const estimatedBytes = estimateHomeBackupBytes(homeDir);
  let freeBytes = Number.POSITIVE_INFINITY;
  try {
    const stat = statfsSync(homeDir);
    freeBytes = stat.bavail * stat.bsize;
  } catch {
    /* statfs unsupported — treat as unbounded, never block on a measurement failure */
  }
  const ratio = freeBytes > 0 ? estimatedBytes / freeBytes : Number.POSITIVE_INFINITY;
  return {
    estimatedBytes,
    freeBytes,
    ratio,
    insufficient: estimatedBytes > freeBytes * threshold,
    threshold,
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

/**
 * Create a durable backup snapshot of the current OP_HOME contents.
 *
 * The backup is written under OP_HOME/data/backups/<timestamp>/ and captures the
 * user/config/state trees (config/, system/, state/, knowledge/) that a
 * destructive operation (e.g. `install --force`) could clobber.
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
 */
export function backupOpenPalmHome(homeDir: string): string | null {
  if (!existsSync(homeDir)) return null;

  const backupDir = join(homeDir, "data", "backups", timestampDirName());
  mkdirSync(backupDir, { recursive: true });

  let copiedAny = false;
  for (const entry of readdirSync(homeDir, { withFileTypes: true })) {
    if (entry.name === "data") continue;
    const sourcePath = join(homeDir, entry.name);
    const targetPath = join(backupDir, entry.name);
    cpSync(sourcePath, targetPath, { recursive: true });
    copiedAny = true;
  }

  return copiedAny ? backupDir : null;
}

export function listBackupDirs(homeDir: string): string[] {
  const backupsDir = join(homeDir, 'data', 'backups');
  if (!existsSync(backupsDir)) return [];

  return readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(backupsDir, entry.name))
    .sort((a, b) => b.localeCompare(a));
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

export function pruneBackupDirs(homeDir: string, keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error('keep must be a non-negative integer');
  }

  const toDelete = listBackupDirs(homeDir).slice(keep);
  for (const backupDir of toDelete) {
    rmSync(backupDir, { recursive: true, force: true });
  }
  return toDelete;
}
