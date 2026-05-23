/**
 * Self-healing install lock for the setup wizard phase.
 *
 * Both `performSetup` (config writes) and `startDeploy` (Docker work) need an
 * exclusive lock against concurrent installs. The lock file lives at
 * `<stateDir>/.install.lock` and contains `<pid>\n<timestamp>\n`.
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
 * Try to acquire the install lock under `stateDir`. Returns a handle on
 * success or null if the lock is held by a live, recent install (or on any
 * unexpected filesystem error — caller should surface "install_in_progress").
 *
 * Callers MUST call `releaseInstallLock()` in a finally block when done.
 */
export function acquireInstallLock(stateDir: string): InstallLockHandle | null {
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch (err) {
    logger.warn("failed to ensure state dir for install lock", {
      stateDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const path = join(stateDir, ".install.lock");

  try {
    if (tryCreate(path)) return { path };
  } catch (err) {
    logger.warn("unexpected error acquiring install lock", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
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

export function releaseInstallLock(handle: InstallLockHandle | null): void {
  if (!handle) return;
  try {
    rmSync(handle.path, { force: true });
  } catch (err) {
    logger.warn("failed to release install lock", {
      path: handle.path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
