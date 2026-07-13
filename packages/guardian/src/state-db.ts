import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type PrincipalKind = 'portal' | 'direct';

export type PrincipalRecord = {
  id: string;
  kind: PrincipalKind;
  label: string;
  tokenHash: string;
  enabled: boolean;
  createdAt: number;
};

const GUARDIAN_HOME = Bun.env.HOME ?? '/opt/openpalm/guardian';
const DB_PATH = Bun.env.GUARDIAN_STATE_DB_PATH ?? join(GUARDIAN_HOME, 'state.db');

let db: Database | null = null;

/**
 * Migration v0 → v1: migrate an existing principals table from the old CHECK
 * constraint `kind IN ('channel', 'direct')` to `kind IN ('portal', 'direct')`.
 *
 * SQLite CHECK constraints cannot be altered in-place, so we detect the old
 * schema via sqlite_master, then recreate the table with the new constraint
 * and migrate rows (replacing 'channel' → 'portal'). The operation is
 * idempotent: if the table already has the new constraint (or does not exist
 * yet), it is a no-op. The sqlite_master sniff is kept (rather than trusting
 * user_version alone) so this step is correct on all three possible
 * version-0 states: fresh DB, old-constraint 0.12.x DB, and an
 * already-rewritten 0.12.x DB that was never stamped. The migration runner
 * (below) owns the transaction the step runs in, so it no longer BEGINs/
 * COMMITs itself — the version stamp commits atomically with the step.
 */
function migrateKindConstraintIfNeeded(database: Database): void {
  type MasterRow = { sql: string };
  const row = database.query<MasterRow, []>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='principals'"
  ).get();

  // Table does not exist yet — nothing to migrate.
  if (!row) return;

  // If the schema already uses the new constraint we are done.
  if (!row.sql.includes("'channel'")) return;

  // Old schema detected — recreate the table with the updated CHECK constraint
  // and remap any 'channel' rows to 'portal'.
  database.exec(`
    CREATE TABLE IF NOT EXISTS principals_new (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('portal', 'direct')),
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO principals_new (id, kind, label, token_hash, enabled, created_at)
      SELECT id,
             CASE WHEN kind = 'channel' THEN 'portal' ELSE kind END,
             label,
             token_hash,
             enabled,
             created_at
      FROM principals;
    DROP TABLE principals;
    ALTER TABLE principals_new RENAME TO principals;
  `);
}

// Ordered migrations: MIGRATIONS[n] takes user_version n → n+1.
const MIGRATIONS: ReadonlyArray<(database: Database) => void> = [
  migrateKindConstraintIfNeeded, // v0 → v1
];

/**
 * Bump when appending to MIGRATIONS. Column policy (#433 close-out):
 * deferred registry columns (protocols, persona, rate_policy) and #435's
 * cert_fingerprint are added by ALTER TABLE under a new user_version step
 * ONLY when their consumer ships — never speculatively.
 */
export const STATE_DB_SCHEMA_VERSION = 1;

function readUserVersion(database: Database): number {
  return (database.query('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/**
 * Apply pragmas, versioned migrations, base schema, and the 0600 file-mode
 * discipline to an open state database. Exported as the unit-test seam
 * (openDatabase() is a singleton bound to env at import time and cannot be
 * exercised in-process across test files).
 */
export function configureStateDatabase(database: Database): void {
  database.exec('PRAGMA journal_mode = WAL'); // must run outside a transaction

  const version = readUserVersion(database);
  if (version > STATE_DB_SCHEMA_VERSION) {
    throw new Error(
      `guardian state DB user_version ${version} is newer than supported ${STATE_DB_SCHEMA_VERSION} — refusing to open (downgrade?)`
    );
  }
  for (let v = version; v < STATE_DB_SCHEMA_VERSION; v++) {
    database.exec('BEGIN');
    try {
      MIGRATIONS[v](database);
      database.exec(`PRAGMA user_version = ${v + 1}`);
      database.exec('COMMIT');
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    }
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS principals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('portal', 'direct')),
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // 0600 discipline: DB file + any WAL sidecars that already exist. Sidecars
  // SQLite creates later inherit the DB file's mode (unix VFS derives
  // wal/shm modes from the main DB file).
  for (const p of [database.filename, `${database.filename}-wal`, `${database.filename}-shm`]) {
    if (existsSync(p)) chmodSync(p, 0o600);
  }
}

function openDatabase(): Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true, mode: 0o700 });
  db = new Database(DB_PATH, { create: true });
  configureStateDatabase(db);
  return db;
}

function rowToPrincipal(row: Record<string, unknown> | null): PrincipalRecord | null {
  if (!row) return null;
  return {
    id: String(row.id ?? ''),
    kind: row.kind === 'direct' ? 'direct' : 'portal',
    label: String(row.label ?? ''),
    tokenHash: String(row.token_hash ?? ''),
    enabled: Number(row.enabled ?? 0) === 1,
    createdAt: Number(row.created_at ?? 0),
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function initializePrincipalStore(): void {
  openDatabase();
}

/**
 * Test-only seam: point the module singleton at a caller-provided,
 * already-{@link configureStateDatabase}d database (or `null` to restore the
 * env-bound default on the next open). The accessor helpers below key off the
 * singleton, which is bound to `GUARDIAN_STATE_DB_PATH` at import time and
 * therefore cannot be exercised in-process across test files without bleeding;
 * injecting an isolated in-memory DB per test file removes that cross-file
 * coupling (PR #564 retest P3-1 create-principal.test.ts).
 */
export function _setStateDatabaseForTests(database: Database | null): void {
  db = database;
}

export function listPrincipals(): PrincipalRecord[] {
  const rows = openDatabase().query('SELECT id, kind, label, token_hash, enabled, created_at FROM principals ORDER BY id').all() as Record<string, unknown>[];
  return rows.map((row) => rowToPrincipal(row)).filter((row): row is PrincipalRecord => row !== null);
}

export function getPrincipalRecord(id: string): PrincipalRecord | null {
  const row = openDatabase().query('SELECT id, kind, label, token_hash, enabled, created_at FROM principals WHERE id = ?').get(id) as Record<string, unknown> | null;
  return rowToPrincipal(row);
}

export function upsertPrincipal(input: { id: string; kind: PrincipalKind; label?: string; token: string; enabled?: boolean }): PrincipalRecord {
  const createdAt = Date.now();
  const label = (input.label?.trim() || input.id).trim();
  openDatabase().query(`
    INSERT INTO principals (id, kind, label, token_hash, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      label = excluded.label,
      token_hash = excluded.token_hash,
      enabled = excluded.enabled
  `).run(input.id, input.kind, label, hashToken(input.token), input.enabled === false ? 0 : 1, createdAt);
  // biome-ignore lint/style/noNonNullAssertion: the INSERT ... ON CONFLICT DO UPDATE above guarantees a row with input.id exists, so the immediate re-read cannot be null.
  return getPrincipalRecord(input.id)!;
}

/**
 * Create-only insertion (PR #564 retest P3-1). Unlike {@link upsertPrincipal},
 * a colliding `id` is NOT overwritten — the existing row (and its token) stays
 * exactly as it was and this returns `null`. Pairing mints a fresh device
 * principal, so a same-id collision must never silently rotate an existing
 * device's credential; the caller retries with a new id or reports a conflict.
 */
export function createPrincipal(input: { id: string; kind: PrincipalKind; label?: string; token: string; enabled?: boolean }): PrincipalRecord | null {
  const createdAt = Date.now();
  const label = (input.label?.trim() || input.id).trim();
  const result = openDatabase().query(`
    INSERT INTO principals (id, kind, label, token_hash, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(input.id, input.kind, label, hashToken(input.token), input.enabled === false ? 0 : 1, createdAt);
  if (result.changes === 0) return null; // id already exists — leave it untouched
  return getPrincipalRecord(input.id);
}

export function rotatePrincipal(id: string, token: string): PrincipalRecord | null {
  openDatabase().query('UPDATE principals SET token_hash = ? WHERE id = ?').run(hashToken(token), id);
  return getPrincipalRecord(id);
}

export function setPrincipalEnabled(id: string, enabled: boolean): PrincipalRecord | null {
  openDatabase().query('UPDATE principals SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return getPrincipalRecord(id);
}

export function deletePrincipal(id: string): boolean {
  return openDatabase().query('DELETE FROM principals WHERE id = ?').run(id).changes > 0;
}

export function seedPortalPrincipalsFromEnv(): PrincipalRecord[] {
  const seeded: PrincipalRecord[] = [];
  for (const [key, value] of Object.entries(Bun.env)) {
    if (!key.startsWith('PORTAL_') || !key.endsWith('_SECRET_FILE') || !value) continue;
    if (!existsSync(value)) continue;
    const token = readFileSync(value, 'utf-8').replace(/[\r\n]+$/, '');
    if (!token) continue;
    const id = key.slice('PORTAL_'.length, -'_SECRET_FILE'.length).toLowerCase();
    seeded.push(upsertPrincipal({ id, kind: 'portal', label: id, token }));
  }
  return seeded;
}
