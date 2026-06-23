/**
 * Self-healing install lock for the setup wizard phase.
 *
 * Both `performSetup` (config writes) and `startDeploy` (Docker work) need an
 * exclusive lock against concurrent installs. The lock file lives at
 * `<dataDir>/.install.lock` and contains `<pid>\n<timestamp>\n`.
 *
 * Self-healing rules:
 *  - On EEXIST, parse the holder PID. If the process is gone (`process.kill(pid, 0)`
 *    throws ESRCH) the lock is stale and we remove + retry once.
 *  - If the timestamp is older than STALE_AFTER_MS the lock is stale and we
 *    remove + retry once.
 *  - If the file is unparseable (e.g. written by an older version) fall back to
 *    mtime > STALE_AFTER_MS.
 *
 * On any unexpected error (permissions, ENOSPC, etc.) we return null so the
 * caller surfaces "install_in_progress" rather than silently fake-acquiring.
 */
import { openSync, writeSync, closeSync, readFileSync, statSync, rmSync, mkdirSync, constants } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const logger = createLogger("install-lock");

const STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes

export type InstallLockHandle = {
  path: string;
  /**
   * True when this handle is a REENTRANT no-op: the lock file was already held
   * by THIS process when acquire was called (e.g. a lifecycle wrapper holds the
   * lock and then calls a migration helper that also acquires it). Releasing a
   * reentrant handle does NOT remove the file — only the outermost owner does —
   * so the nested call can't clear a lock it didn't create.
   */
  reentrant?: boolean;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = process exists but we don't own it.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLockContent(content: string): { pid: number | null; timestamp: number | null } {
  const lines = content.split("\n");
  const pid = Number.parseInt(lines[0] ?? "", 10);
  const timestamp = Number.parseInt(lines[1] ?? "", 10);
  return {
    pid: Number.isFinite(pid) && pid > 0 ? pid : null,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null,
  };
}

function isStale(path: string): boolean {
  let content = "";
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    // Can't read — assume held; caller will surface error.
    return false;
  }
  const { pid, timestamp } = parseLockContent(content);
  if (pid !== null) {
    if (!isProcessAlive(pid)) return true;
    if (timestamp !== null && Date.now() - timestamp > STALE_AFTER_MS) return true;
    return false;
  }
  // Unparseable — fall back to mtime.
  try {
    const stat = statSync(path);
    return Date.now() - stat.mtimeMs > STALE_AFTER_MS;
  } catch {
    return false;
  }
}

function tryCreate(path: string): boolean {
  const content = `${process.pid}\n${Date.now()}\n`;
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
    try {
      writeSync(fd, content);
    } finally {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    // Unexpected error — propagate so caller returns null.
    throw err;
  }
}

/**
 * Try to acquire the install lock under `dataDir`. Returns a handle on
 * success or null if the lock is held by a live, recent install (or on any
 * unexpected filesystem error — caller should surface "install_in_progress").
 *
 * Callers MUST call `releaseInstallLock()` in a finally block when done.
 */
export function acquireInstallLock(dataDir: string): InstallLockHandle | null {
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    logger.warn("failed to ensure data dir for install lock", {
      dataDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const path = join(dataDir, ".install.lock");

  try {
    if (tryCreate(path)) return { path };
  } catch (err) {
    logger.warn("unexpected error acquiring install lock", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // EEXIST — the lock is held. Reentrant case: if THIS process already holds it
  // (a lifecycle wrapper holds the lock, then a nested migration helper acquires
  // it again), grant a no-op handle instead of self-deadlocking. The file-based
  // O_EXCL lock excludes OTHER processes; it must not block one process's own
  // nested acquisitions.
  try {
    const { pid } = parseLockContent(readFileSync(path, "utf-8"));
    if (pid === process.pid) return { path, reentrant: true };
  } catch {
    // Unreadable lock content — fall through to the staleness check.
  }

  // EEXIST — check whether the existing lock is stale.
  if (!isStale(path)) return null;

  logger.info("removing stale install lock and retrying acquire", { path });
  try {
    rmSync(path, { force: true });
  } catch (err) {
    logger.warn("failed to remove stale install lock", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  try {
    if (tryCreate(path)) return { path };
  } catch (err) {
    logger.warn("unexpected error re-acquiring install lock", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  // Lost the race with another acquirer.
  return null;
}

export const INSTALL_LOCK_STALE_AFTER_MS = STALE_AFTER_MS;

export type InstallLockStatus =
  | { present: false; path: string }
  | {
      present: true;
      path: string;
      pid: number | null;
      timestamp: number | null;
      ageMs: number | null;
      stale: boolean;
    };

/**
 * Inspect the install lock under `dataDir` without modifying it. Used by the
 * `openpalm unlock` command and the UI "operation stuck?" affordance to decide
 * whether a removal is safe.
 */
export function inspectInstallLock(dataDir: string): InstallLockStatus {
  const path = join(dataDir, ".install.lock");
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false, path };
    }
    // Present but unreadable — report it as present + stale-by-mtime if we can.
    let ageMs: number | null = null;
    try {
      ageMs = Date.now() - statSync(path).mtimeMs;
    } catch {
      /* best-effort */
    }
    return {
      present: true,
      path,
      pid: null,
      timestamp: null,
      ageMs,
      stale: isStale(path),
    };
  }
  const { pid, timestamp } = parseLockContent(content);
  const ageMs = timestamp !== null ? Date.now() - timestamp : null;
  return {
    present: true,
    path,
    pid,
    timestamp,
    ageMs,
    stale: isStale(path),
  };
}

export type UnlockResult =
  | { ok: true; removed: boolean; status: InstallLockStatus }
  | { ok: false; reason: "live"; status: InstallLockStatus };

/**
 * Remove the install lock ONLY if it is stale (dead holder PID or older than
 * the 30-minute staleness window). Never blind-removes a lock held by a live,
 * recent install. Returns `{ ok: false, reason: "live" }` when the lock is
 * still active so the caller can surface a clear message instead of forcing.
 */
export function unlockInstallLock(dataDir: string): UnlockResult {
  const status = inspectInstallLock(dataDir);
  if (!status.present) {
    // Nothing to remove — treat as success (idempotent).
    return { ok: true, removed: false, status };
  }
  if (!status.stale) {
    return { ok: false, reason: "live", status };
  }
  try {
    rmSync(status.path, { force: true });
    logger.info("removed stale install lock via unlock", { path: status.path });
  } catch (err) {
    logger.warn("failed to remove stale install lock during unlock", {
      path: status.path,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  return { ok: true, removed: true, status };
}

export function releaseInstallLock(handle: InstallLockHandle | null): void {
  if (!handle) return;
  // A reentrant handle never owned the file — the outermost acquirer removes it.
  if (handle.reentrant) return;
  try {
    rmSync(handle.path, { force: true });
  } catch (err) {
    logger.warn("failed to release install lock", {
      path: handle.path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
