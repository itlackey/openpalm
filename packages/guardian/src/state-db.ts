import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { clampPositiveInt, SESSION_ACTIVE_GRACE_MS } from './config.ts';
import { createLogger } from './logger.ts';

const logger = createLogger('guardian:state-db');

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

/**
 * Migration v1 → v2: add the /oc proxy's session + permission ownership tables.
 *
 * Ownership (which principal owns a session / a permission-or-question request)
 * used to live in in-memory module Maps and was LOST on every guardian restart —
 * orphaning live conversations (every follow-up call 403'd forbidden_session).
 * Persisting it here means a restarted guardian still recognises the sessions and
 * pending permission requests its principals own. Idempotent CREATE IF NOT EXISTS
 * so a fresh DB and an existing v1 DB converge on the same schema.
 */
function createOwnershipTables(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_owners (
      session_id TEXT PRIMARY KEY,
      principal_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS session_owners_principal ON session_owners(principal_key);
    CREATE INDEX IF NOT EXISTS session_owners_last_used ON session_owners(last_used_at);
    CREATE TABLE IF NOT EXISTS permission_owners (
      request_id TEXT PRIMARY KEY,
      principal_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

/**
 * Migration v2 → v3: add the session-eviction reconciliation log (S4, #581
 * finding #7).
 *
 * `session_owners` is bounded (evicts its oldest row past
 * GUARDIAN_OWNERSHIP_MAX_ROWS, see evictOldestSessionOwners below) — but
 * deleting the ownership row alone does NOT delete the underlying OpenCode
 * session. Before this table existed, an evicted session became a permanent,
 * undeletable orphan: no principal could list it (GET /session is filtered to
 * owned rows) or delete it (DELETE /session/{id} would 403 forbidden_session
 * with no owner on record), yet it stayed durable on disk forever. Every
 * eviction now persists a row here FIRST, in the same eviction step, so an
 * async sweep (reconciliation.ts) can still delete/archive the session
 * upstream and mark it reconciled. Idempotent CREATE IF NOT EXISTS so a fresh
 * DB and an existing v2 DB converge on the same schema.
 */
function createEvictionLogTable(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_eviction_log (
      session_id TEXT PRIMARY KEY,
      principal_key TEXT NOT NULL,
      evicted_at INTEGER NOT NULL,
      reconciled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS session_eviction_log_pending ON session_eviction_log(reconciled_at);
  `);
}

/**
 * Migration v3 → v4: add session_owners.last_used_at for lifecycle-aware
 * eviction (S4 Fix A, #586) — eviction candidates used to be ordered by
 * created_at and never refreshed, so a long-lived active session with a
 * stale created_at could be evicted (and its upstream OpenCode session
 * destroyed) mid-conversation. Backfills the new column from created_at so
 * existing rows keep their current relative eviction order until touched.
 *
 * `createOwnershipTables` is reused as BOTH the v1→v2 migration step AND the
 * unconditional configure-time CREATE below (`:184-188`-era comment) — so on
 * a FRESH database this step and that one share one pass through the
 * migration loop, and by the time THIS step runs, `session_owners` was
 * already created two steps earlier WITH `last_used_at` (the DDL above is
 * shared). Sniff `PRAGMA table_info` and no-op if the column already exists
 * — same precedent as `migrateKindConstraintIfNeeded`'s sqlite_master sniff.
 */
function migrateSessionOwnersLastUsedIfNeeded(database: Database): void {
  type ColumnInfo = { name: string };
  const columns = database.query<ColumnInfo, []>('PRAGMA table_info(session_owners)').all();
  if (columns.some((c) => c.name === 'last_used_at')) return; // fresh-DB convergence — already present

  database.exec(`
    ALTER TABLE session_owners ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0;
    UPDATE session_owners SET last_used_at = created_at;
    CREATE INDEX IF NOT EXISTS session_owners_last_used ON session_owners(last_used_at);
  `);
}

// Ordered migrations: MIGRATIONS[n] takes user_version n → n+1.
const MIGRATIONS: ReadonlyArray<(database: Database) => void> = [
  migrateKindConstraintIfNeeded, // v0 → v1
  createOwnershipTables, // v1 → v2
  createEvictionLogTable, // v2 → v3
  migrateSessionOwnersLastUsedIfNeeded, // v3 → v4
];

/**
 * Bump when appending to MIGRATIONS. Column policy (#433 close-out):
 * deferred registry columns (protocols, persona, rate_policy) and #435's
 * cert_fingerprint are added by ALTER TABLE under a new user_version step
 * ONLY when their consumer ships — never speculatively.
 */
export const STATE_DB_SCHEMA_VERSION = 4;

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
  // Ownership tables share their DDL with the v1 → v2 migration so a fresh DB
  // and an upgraded one can never drift.
  createOwnershipTables(database);
  // Same convergence guarantee for the v2 → v3 eviction log.
  createEvictionLogTable(database);

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

// ── /oc proxy ownership (session + permission), persisted so a guardian restart
// does not orphan the sessions/permission requests its principals own. ──────────
//
// Bounded oldest-idle-first (last_used_at, S4 Fix A #586 — was created_at,
// never refreshed) so authenticated input cannot grow the DB without limit —
// the same size-cap discipline the previous in-memory Maps used. A session
// touched (proxy.ts, on every authorized session-scoped request) or restored
// by the reconciliation sweep (decision 586-1) is never selected as an idle
// candidate while within GUARDIAN_SESSION_ACTIVE_GRACE_MS of its last use —
// see evictOldestSessionOwners' soft cap below.
/**
 * Clamp a GUARDIAN_OWNERSHIP_MAX_ROWS override to a usable positive integer.
 * A non-numeric override yields NaN, which binds to SQLite as NULL and turns
 * the eviction `LIMIT MAX(0, count - ?)` into `LIMIT NULL` (unbounded) —
 * deleting the ENTIRE ownership table on the next insert; a fractional value
 * in (0, 1) flooring to 0 would wipe it the same way. Delegates to config's
 * shared clampPositiveInt (floor-first, >= 1). Exported for tests.
 */
export function _clampOwnershipMaxRows(raw: string | undefined): number {
  return clampPositiveInt(raw, 10_000);
}

const OWNERSHIP_MAX_ROWS = _clampOwnershipMaxRows(Bun.env.GUARDIAN_OWNERSHIP_MAX_ROWS);

/**
 * Clamp a GUARDIAN_EVICTION_LOG_MAX_ROWS override the same way as
 * {@link _clampOwnershipMaxRows} — a malformed value must never resolve to an
 * unbounded (or zero) prune limit. Exported for tests.
 */
export function _clampEvictionLogMaxRows(raw: string | undefined): number {
  return clampPositiveInt(raw, 10_000);
}

const EVICTION_LOG_MAX_ROWS = _clampEvictionLogMaxRows(Bun.env.GUARDIAN_EVICTION_LOG_MAX_ROWS);

/** Evicts permission_owners' oldest rows past the cap. (permission requests
 *  have no durable upstream counterpart to reconcile — unlike session_owners,
 *  see evictOldestSessionOwners — so a plain bounded delete is sufficient.) */
function evictOldestPermissionOwners(database: Database, maxRows: number = OWNERSHIP_MAX_ROWS): void {
  database
    .query(
      `DELETE FROM permission_owners WHERE request_id IN (
         SELECT request_id FROM permission_owners
         ORDER BY created_at ASC, request_id ASC
         LIMIT MAX(0, (SELECT COUNT(*) FROM permission_owners) - ?))`,
    )
    .run(maxRows);
}

// Rate-limit the two state-transition warns below to ONE line per crossing
// (idle→over-cap, or below-cap→idle-again) rather than on every hot-path
// insert while the condition persists — both fire from recordSessionOwnerRow,
// which runs on every session-scoped write.
let evictionLogOverCapWarned = false;
let sessionOwnersSoftCapWarned = false;

/**
 * Bound `session_eviction_log` itself so a reconciliation sweep that is
 * disabled/behind never lets it grow forever either. Fix B (#586): the
 * candidate set for deletion is reconciled rows ONLY (`reconciled_at IS NOT
 * NULL`) — a pending (never-reconciled) row is structurally unreachable by
 * this prune, no matter how far over `maxRows` the table grows. This used to
 * prefer reconciled rows first but still fall through to the oldest pending
 * row once reconciled rows ran out, silently dropping an orphan's only
 * record; never-delete-user-data outranks eviction-log hygiene, so a
 * structural guarantee replaces the preference. When pending rows alone
 * exceed `maxRows`, that's surfaced via a rate-limited structured warn
 * instead of a silent drop.
 */
function pruneEvictionLog(database: Database, maxRows: number = EVICTION_LOG_MAX_ROWS): void {
  database
    .query(
      `DELETE FROM session_eviction_log WHERE session_id IN (
         SELECT session_id FROM session_eviction_log
         WHERE reconciled_at IS NOT NULL
         ORDER BY evicted_at ASC, session_id ASC
         LIMIT MAX(0, (SELECT COUNT(*) FROM session_eviction_log) - ?))`,
    )
    .run(maxRows);

  const { n: pendingCount } = database
    .query('SELECT COUNT(*) AS n FROM session_eviction_log WHERE reconciled_at IS NULL')
    .get() as { n: number };
  if (pendingCount > maxRows) {
    if (!evictionLogOverCapWarned) {
      logger.warn('eviction_log_pending_over_cap', { pendingCount, maxRows });
      evictionLogOverCapWarned = true;
    }
  } else {
    evictionLogOverCapWarned = false;
  }
}

/**
 * Evict `session_owners`' oldest-IDLE rows past `maxRows` — but, unlike
 * permission_owners, each evicted row maps 1:1 to a DURABLE upstream OpenCode
 * session (S4, #581 finding #7). Deleting the ownership row without a trace
 * would make that session an undeletable orphan: no principal can list it
 * (GET /session filters to owned rows) or DELETE it (403 forbidden_session,
 * no owner on record) ever again, yet it stays on disk. So every evicted
 * session_id is logged into session_eviction_log FIRST (same call, ON
 * CONFLICT so a rare re-eviction of a reused id flips back to pending rather
 * than silently staying "reconciled") — the async sweep in reconciliation.ts
 * is what actually deletes/archives it upstream.
 *
 * Fix A (#586, defect A): candidates are no longer every row oldest-by-
 * created_at — only rows whose `last_used_at` is OLDER than `activeGraceMs`
 * qualify (ordered oldest-idle-first). This is the SOFT CAP: when fewer idle
 * candidates exist than the overflow, only the idle ones are evicted and a
 * rate-limited structured warn is emitted — the table may temporarily exceed
 * `maxRows` rather than destroy an active conversation. Never-delete-user-
 * data outranks table hygiene.
 */
function evictOldestSessionOwners(
  database: Database,
  maxRows: number = OWNERSHIP_MAX_ROWS,
  evictionLogMaxRows: number = EVICTION_LOG_MAX_ROWS,
  activeGraceMs: number = SESSION_ACTIVE_GRACE_MS,
  now: number = Date.now(),
): void {
  const { n: count } = database.query('SELECT COUNT(*) AS n FROM session_owners').get() as { n: number };
  const overflow = count - maxRows;
  if (overflow <= 0) {
    sessionOwnersSoftCapWarned = false;
    return;
  }

  const cutoff = now - activeGraceMs;
  const toEvict = database
    .query(
      'SELECT session_id, principal_key FROM session_owners WHERE last_used_at <= ? ORDER BY last_used_at ASC, session_id ASC LIMIT ?',
    )
    .all(cutoff, overflow) as { session_id: string; principal_key: string }[];

  if (toEvict.length < overflow) {
    if (!sessionOwnersSoftCapWarned) {
      logger.warn('session_owners_soft_cap_active_sessions_retained', {
        count,
        maxRows,
        overflow,
        idleCandidates: toEvict.length,
        activeGraceMs,
      });
      sessionOwnersSoftCapWarned = true;
    }
  } else {
    sessionOwnersSoftCapWarned = false;
  }
  if (toEvict.length === 0) return;

  const insertLog = database.query(
    `INSERT INTO session_eviction_log (session_id, principal_key, evicted_at, reconciled_at)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT(session_id) DO UPDATE SET
       principal_key = excluded.principal_key,
       evicted_at = excluded.evicted_at,
       reconciled_at = NULL`,
  );
  const deleteOwner = database.query('DELETE FROM session_owners WHERE session_id = ?');
  for (const row of toEvict) {
    insertLog.run(row.session_id, row.principal_key, now);
    deleteOwner.run(row.session_id);
  }
  pruneEvictionLog(database, evictionLogMaxRows);
}

/**
 * Record that `principalKey` owns `sessionId`, refreshing `last_used_at` to
 * `createdAt` (S4 Fix A, #586 — the initial "use" is the create itself), then
 * evict past the cap. The only public entry to the eviction path, so
 * `activeGraceMs`/`now` are threaded through here too (defaulting to the real
 * grace/clock) — tests cannot drive evictOldestSessionOwners' soft cap
 * deterministically without them.
 */
export function recordSessionOwnerRow(
  sessionId: string,
  principalKey: string,
  createdAt: number,
  database: Database = openDatabase(),
  maxRows: number = OWNERSHIP_MAX_ROWS,
  evictionLogMaxRows: number = EVICTION_LOG_MAX_ROWS,
  activeGraceMs: number = SESSION_ACTIVE_GRACE_MS,
  now: number = Date.now(),
): void {
  database
    .query(
      `INSERT INTO session_owners (session_id, principal_key, created_at, last_used_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         principal_key = excluded.principal_key,
         last_used_at = excluded.last_used_at`,
    )
    .run(sessionId, principalKey, createdAt, createdAt);
  evictOldestSessionOwners(database, maxRows, evictionLogMaxRows, activeGraceMs, now);
}

/**
 * Refresh `sessionId`'s `last_used_at` without touching `principal_key` or
 * `created_at` — called from proxy.ts immediately after every authorized
 * session-scoped request (the single choke point covering message/
 * prompt_async/abort/history/DELETE, per the #586 design). A no-op if the
 * session isn't owned (0 rows affected). Keeps the row out of
 * evictOldestSessionOwners' idle-candidate set while genuinely in use.
 */
export function touchSessionOwnerRow(
  sessionId: string,
  now: number = Date.now(),
  database: Database = openDatabase(),
): void {
  database.query('UPDATE session_owners SET last_used_at = ? WHERE session_id = ?').run(now, sessionId);
}

/**
 * Restore (un-evict) an ownership row the reconciliation sweep found still
 * active upstream (decision 586-1) — re-insert `session_owners` with a fresh
 * `last_used_at` under the retained `principal_key` (the eviction log keeps
 * it, `:118-125`-era comment) and mark the log row reconciled: the incident
 * is resolved (the session survived), not left pending for a retry. Without
 * restoration the principal stays locked out (every `/oc` call 403s
 * forbidden_session) until the session eventually goes idle and is deleted
 * anyway — only restoring actually satisfies "never evict an active session".
 */
export function restoreSessionOwnerRow(
  sessionId: string,
  principalKey: string,
  now: number = Date.now(),
  database: Database = openDatabase(),
): void {
  database
    .query(
      `INSERT INTO session_owners (session_id, principal_key, created_at, last_used_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         principal_key = excluded.principal_key,
         last_used_at = excluded.last_used_at`,
    )
    .run(sessionId, principalKey, now, now);
  markSessionReconciled(sessionId, database);
}

export function getSessionOwnerKey(sessionId: string): string | null {
  const row = openDatabase()
    .query('SELECT principal_key FROM session_owners WHERE session_id = ?')
    .get(sessionId) as { principal_key?: unknown } | null;
  return row && typeof row.principal_key === 'string' ? row.principal_key : null;
}

export function deleteSessionOwnerRow(sessionId: string): void {
  openDatabase().query('DELETE FROM session_owners WHERE session_id = ?').run(sessionId);
}

export function listOwnedSessionIds(principalKey: string): string[] {
  const rows = openDatabase()
    .query('SELECT session_id FROM session_owners WHERE principal_key = ?')
    .all(principalKey) as { session_id: string }[];
  return rows.map((row) => row.session_id);
}

export function countSessionOwners(): number {
  return (openDatabase().query('SELECT COUNT(*) AS n FROM session_owners').get() as { n: number }).n;
}

export function recordPermissionOwnerRow(requestId: string, principalKey: string, createdAt: number): void {
  const database = openDatabase();
  database
    .query(
      `INSERT INTO permission_owners (request_id, principal_key, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET principal_key = excluded.principal_key`,
    )
    .run(requestId, principalKey, createdAt);
  evictOldestPermissionOwners(database);
}

export function getPermissionOwnerKey(requestId: string): string | null {
  const row = openDatabase()
    .query('SELECT principal_key FROM permission_owners WHERE request_id = ?')
    .get(requestId) as { principal_key?: unknown } | null;
  return row && typeof row.principal_key === 'string' ? row.principal_key : null;
}

export function countPermissionOwners(): number {
  return (openDatabase().query('SELECT COUNT(*) AS n FROM permission_owners').get() as { n: number }).n;
}

// ── Session eviction reconciliation log (S4, #581 finding #7) ──────────────
// Populated by evictOldestSessionOwners above; consumed by the async sweep in
// reconciliation.ts, which deletes/archives each pending session upstream and
// then calls markSessionReconciled — decoupled from the hot session-create
// request path that recordSessionOwnerRow runs on.

export type PendingEvictedSession = { sessionId: string; principalKey: string; evictedAt: number };

/** Oldest-first pending (never-reconciled) evicted sessions, up to `limit`. */
export function listPendingEvictedSessions(
  limit = 100,
  database: Database = openDatabase(),
): PendingEvictedSession[] {
  const rows = database
    .query(
      'SELECT session_id, principal_key, evicted_at FROM session_eviction_log WHERE reconciled_at IS NULL ORDER BY evicted_at ASC, session_id ASC LIMIT ?',
    )
    .all(limit) as { session_id: string; principal_key: string; evicted_at: number }[];
  return rows.map((row) => ({ sessionId: row.session_id, principalKey: row.principal_key, evictedAt: row.evicted_at }));
}

/** Mark a pending evicted session as reconciled (its upstream session was
 *  confirmed deleted/archived) — stamps reconciled_at rather than deleting
 *  the row outright, keeping an audit trail of what the sweep has handled. */
export function markSessionReconciled(sessionId: string, database: Database = openDatabase()): void {
  database.query('UPDATE session_eviction_log SET reconciled_at = ? WHERE session_id = ?').run(Date.now(), sessionId);
}

/** Pending (unreconciled) evicted-session count for the /stats endpoint. */
export function countPendingEvictedSessions(database: Database = openDatabase()): number {
  return (
    database.query('SELECT COUNT(*) AS n FROM session_eviction_log WHERE reconciled_at IS NULL').get() as { n: number }
  ).n;
}

/** Test-only: clear ownership + eviction-log tables between cases. */
export function clearOwnershipTables(): void {
  const database = openDatabase();
  database.query('DELETE FROM session_owners').run();
  database.query('DELETE FROM permission_owners').run();
  database.query('DELETE FROM session_eviction_log').run();
}
