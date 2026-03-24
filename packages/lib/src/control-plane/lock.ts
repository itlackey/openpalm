/**
 * Orchestrator lock — prevents concurrent mutating operations.
 *
 * Uses O_CREAT | O_EXCL for atomic exclusive file creation.
 * Lock file lives at {dataDir}/.openpalm.lock containing JSON
 * with { pid, operation, acquiredAt }.
 *
 * Uses node:fs (not Bun) since lib must be Node-compatible for SvelteKit admin.
 */
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync, constants } from "node:fs";
import { dirname } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────

export type LockInfo = {
  pid: number;
  operation: string;
  acquiredAt: string;
};

export type LockHandle = {
  path: string;
  info: LockInfo;
};

// ── Error ────────────────────────────────────────────────────────────────

export class LockAcquisitionError extends Error {
  public readonly holder: LockInfo;

  constructor(holder: LockInfo) {
    super(
      `Cannot acquire lock: already held by PID ${holder.pid} ` +
      `for "${holder.operation}" since ${holder.acquiredAt}`
    );
    this.name = "LockAcquisitionError";
    this.holder = holder;
  }
}

// ── Path ─────────────────────────────────────────────────────────────────

export function lockPath(opHome: string): string {
  return `${opHome}/data/.openpalm.lock`;
}

// ── Stale PID Detection ──────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Read existing lock info ──────────────────────────────────────────────

function readLockInfo(path: string): LockInfo | null {
  try {
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content);
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.operation === "string" &&
      typeof parsed.acquiredAt === "string"
    ) {
      return parsed as LockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Acquire / Release ────────────────────────────────────────────────────

export function acquireLock(opHome: string, operation: string): LockHandle {
  const path = lockPath(opHome);
  mkdirSync(dirname(path), { recursive: true });
  const info: LockInfo = {
    pid: process.pid,
    operation,
    acquiredAt: new Date().toISOString(),
  };
  const content = JSON.stringify(info) + "\n";

  try {
    // Atomic exclusive create — fails if file already exists
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    writeSync(fd, content);
    closeSync(fd);
    return { path, info };
  } catch (err: unknown) {
    // File already exists — check if it's stale
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = readLockInfo(path);

      if (existing && !isProcessAlive(existing.pid)) {
        // Stale lock — remove and retry once
        try {
          unlinkSync(path);
        } catch {
          // Race: another process already removed it; fall through to retry
        }
        // Retry acquisition
        try {
          const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
          writeSync(fd, content);
          closeSync(fd);
          return { path, info };
        } catch (retryErr: unknown) {
          if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") {
            // Another process won the race — read the new holder
            const newHolder = readLockInfo(path);
            throw new LockAcquisitionError(
              newHolder ?? { pid: 0, operation: "unknown", acquiredAt: "unknown" }
            );
          }
          throw retryErr;
        }
      }

      // Lock is held by a live process (or corrupt file — treat as held)
      if (existing) {
        throw new LockAcquisitionError(existing);
      }

      // Corrupt lock file — remove and retry
      try {
        unlinkSync(path);
      } catch {
        // ignore
      }
      try {
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
        writeSync(fd, content);
        closeSync(fd);
        return { path, info };
      } catch (retryErr: unknown) {
        if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") {
          const newHolder = readLockInfo(path);
          throw new LockAcquisitionError(
            newHolder ?? { pid: 0, operation: "unknown", acquiredAt: "unknown" }
          );
        }
        throw retryErr;
      }
    }

    throw err;
  }
}

export function releaseLock(handle: LockHandle): void {
  // Verify ownership before deleting — only remove if we still own it
  const existing = readLockInfo(handle.path);
  if (!existing) return; // Already gone — idempotent
  if (existing.pid !== handle.info.pid) return; // Not ours — don't touch

  try {
    unlinkSync(handle.path);
  } catch {
    // Already removed — idempotent
  }
}
