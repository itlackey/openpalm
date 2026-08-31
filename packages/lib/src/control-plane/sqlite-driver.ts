/**
 * Shared lazy SQLite driver seam.
 *
 * Control-plane modules that touch SQLite files directly (akm-db-journal.ts,
 * opencode-db-maintenance.ts) share two constraints, solved once here:
 *
 *  1. The barrel must stay importable under plain Node. `bun:sqlite` is a Bun
 *     built-in, and these modules are re-exported from the @openpalm/lib
 *     barrel, which Node/Vitest consumers (ui, electron) import — a static
 *     value import would make the whole barrel unloadable under Node
 *     (ERR_MODULE_NOT_FOUND). So the driver is resolved lazily, on the first
 *     actual open.
 *
 *  2. Not every caller runs under Bun. applyHomeAssets (and with it the akm
 *     WAL-residue sweep) also runs in Electron's main process, so after
 *     `bun:sqlite` this tries `node:sqlite` (Node >= 22). When neither loads,
 *     {@link loadSqliteOpen} reports that as `null` for callers that can
 *     degrade (the WAL sweep records the stores it left behind), and
 *     {@link requireSqliteOpen} throws for callers that need a real answer
 *     (size accounting, VACUUM).
 *
 * The connection surface is deliberately minimal — one-shot PRAGMA reads and
 * fire-and-forget SQL — because that is all the maintenance-style callers
 * need. Anything richer (prepared-statement reuse, transactions with bound
 * parameters) should keep using `bun:sqlite` directly from Bun-only code.
 */
import { createRequire } from "node:module";

export interface SqliteOpenOptions {
  /** Open read-only — reads never risk taking a write lock on a live store. */
  readonly?: boolean;
}

export interface SqliteConnection {
  /** Run `PRAGMA <statement>;` and return its first result row, if any. */
  pragmaRow(statement: string): Record<string, unknown> | null;
  /** Execute SQL, discarding any result rows (VACUUM, fire-and-forget PRAGMAs). */
  exec(sql: string): void;
  close(): void;
}

export type SqliteOpen = (path: string, options?: SqliteOpenOptions) => SqliteConnection;

interface SqliteDatabaseCtor {
  new (path: string, options?: Record<string, unknown>): {
    prepare(sql: string): { get(): unknown };
    exec(sql: string): void;
    close(): void;
  };
}

/**
 * Both drivers expose the same prepare/exec/close surface this seam needs;
 * they differ only in module/constructor names and the spelling of the
 * read-only open option (bun: `readonly`, node: `readOnly`).
 */
const DRIVER_CANDIDATES = [
  { moduleName: "bun:sqlite", ctorName: "Database", readonlyKey: "readonly" },
  { moduleName: "node:sqlite", ctorName: "DatabaseSync", readonlyKey: "readOnly" },
] as const;

const requireHost = createRequire(import.meta.url);
let cachedOpen: SqliteOpen | null | undefined;

/** Resolve the first available driver, memoized process-wide (including the "neither" answer). */
export function loadSqliteOpen(): SqliteOpen | null {
  if (cachedOpen !== undefined) return cachedOpen;
  cachedOpen = null;
  for (const { moduleName, ctorName, readonlyKey } of DRIVER_CANDIDATES) {
    let Ctor: SqliteDatabaseCtor | undefined;
    try {
      Ctor = (requireHost(moduleName) as Record<string, SqliteDatabaseCtor>)[ctorName];
    } catch {
      continue; // driver not available in this runtime — try the next
    }
    if (!Ctor) continue;
    const ctor = Ctor;
    cachedOpen = (path, options) => {
      const db = new ctor(path, options?.readonly ? { [readonlyKey]: true } : undefined);
      return {
        pragmaRow: (statement) =>
          (db.prepare(`PRAGMA ${statement};`).get() as Record<string, unknown> | undefined) ??
          null,
        exec: (sql) => db.exec(sql),
        close: () => db.close(),
      };
    };
    break;
  }
  return cachedOpen;
}

/** Like {@link loadSqliteOpen}, for callers that cannot degrade — throws when no driver loads. */
export function requireSqliteOpen(): SqliteOpen {
  const open = loadSqliteOpen();
  if (!open) {
    throw new Error("No SQLite driver available in this runtime (tried bun:sqlite, node:sqlite).");
  }
  return open;
}
