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
 * Migrate an existing principals table from the old CHECK constraint
 * `kind IN ('channel', 'direct')` to `kind IN ('portal', 'direct')`.
 *
 * SQLite CHECK constraints cannot be altered in-place, so we detect the old
 * schema via sqlite_master, then recreate the table with the new constraint
 * and migrate rows (replacing 'channel' → 'portal'). The operation is
 * idempotent: if the table already has the new constraint (or does not exist
 * yet), it is a no-op.
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
    BEGIN;
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
    COMMIT;
  `);
}

function openDatabase(): Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true, mode: 0o700 });
  db = new Database(DB_PATH, { create: true });
  chmodSync(DB_PATH, 0o600);

  // Run the kind-constraint migration BEFORE creating the table (if the table
  // already exists with the old schema the CREATE IF NOT EXISTS below is a
  // no-op, so we must migrate first).
  migrateKindConstraintIfNeeded(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS principals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('portal', 'direct')),
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
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

export function rotatePrincipal(id: string, token: string): PrincipalRecord | null {
  openDatabase().query('UPDATE principals SET token_hash = ? WHERE id = ?').run(hashToken(token), id);
  return getPrincipalRecord(id);
}

export function setPrincipalEnabled(id: string, enabled: boolean): PrincipalRecord | null {
  openDatabase().query('UPDATE principals SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return getPrincipalRecord(id);
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
