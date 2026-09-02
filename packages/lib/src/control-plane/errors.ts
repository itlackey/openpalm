/** Small error-handling utilities shared across the control plane. */
import { accessSync, constants, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

/**
 * Normalize an unknown thrown value to a human-readable message string.
 *
 * Replaces the `err instanceof Error ? err.message : String(err)` idiom that
 * recurs across control-plane modules. An `Error` yields its `message`; anything
 * else is coerced with `String(...)`.
 */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort diagnostic scan: find the first unreadable file under `root`,
 * depth-first. Exists because `fs.cpSync`'s internal recursive copy does NOT
 * set `.path`/`.dest` on the EACCES/EPERM it throws (verified against Bun
 * 1.3.14 — unlike `readFileSync`/`renameSync`/`rmSync`, which do), so the one
 * copy primitive `overwriteSystemTree` and `backupOpenPalmHome` actually use
 * is exactly the case with no path to report without this. Read-only (never
 * mutates), and any surprise here (a file removed mid-scan, a directory that
 * itself denies listing) degrades to "no answer" rather than throwing — this
 * only enriches an error message that is being thrown regardless, so a
 * scan failure must never replace or swallow the real one.
 */
function findUnreadablePath(root: string): string | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return root; // root itself is the problem (unlistable directory).
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findUnreadablePath(full);
      if (nested) return nested;
      continue;
    }
    try {
      accessSync(full, constants.R_OK);
    } catch {
      return full;
    }
  }
  return null;
}

/**
 * When `err` is a filesystem EACCES/EPERM, build an actionable replacement
 * that names the offending path and the remedy, instead of the bare
 * `EACCES: permission denied, rm '…'` #641/#642 surfaced. Returns `null` for
 * every other error so the caller rethrows the original unchanged — this
 * never swallows or downgrades an error, only relabels the one case where the
 * raw Node message leaves an operator with a path and no next step.
 *
 * `scanRoot`, when given, is a fallback ONLY used when the error itself
 * carries no `.path`/`.dest` — see {@link findUnreadablePath} for why that
 * happens for `cpSync` specifically. Pass the read-side root being copied
 * FROM (the tree that already existed and could hold a foreign-owned file),
 * not the freshly-created destination.
 *
 * Shared by `overwriteSystemTree` (core-assets.ts) and `backupOpenPalmHome`
 * (backup.ts): both write into `OP_HOME` trees a prior root-owned run (or a
 * host/drive swap) can leave with foreign-owned files, and both must still
 * throw — never continue past a write they could not make.
 */
export function actionableOwnershipError(err: unknown, scanRoot?: string): Error | null {
  // `dest` is not part of Node's ErrnoException type but IS set at runtime
  // by rename-shaped errors (verified against Bun 1.3.14).
  const errno = err as (NodeJS.ErrnoException & { dest?: string }) | null;
  const code = errno?.code;
  if (code !== "EACCES" && code !== "EPERM") return null;
  const path = errno?.path ?? errno?.dest ?? (scanRoot && findUnreadablePath(scanRoot)) ?? "(unknown path)";
  return new Error(
    `${path} is not owned by this operator, so it could not be written. ` +
      "Run `openpalm repair-ownership` (or `openpalm start --adopt-host` if this " +
      "follows a host or drive change) and retry.",
  );
}
