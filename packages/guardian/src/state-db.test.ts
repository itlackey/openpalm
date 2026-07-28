/**
 * state-db.ts unit tests — WAL mode, `user_version` migration bookkeeping
 * (#433), and the kind-constraint migration ('channel' → 'portal', v0→v1).
 *
 * All tests drive the exported seam `configureStateDatabase(database)`
 * against a raw `bun:sqlite` `Database` opened on a `mkdtempSync` temp path —
 * never the module singleton (`openDatabase()`), because bun:test shares the
 * module cache across files, so the singleton + import-time env read would
 * bleed between files (see auth.test.ts for the same constraint documented
 * against the singleton).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _clampOwnershipMaxRows,
  _clampEvictionLogMaxRows,
  configureStateDatabase,
  countPendingEvictedSessions,
  listPendingEvictedSessions,
  markSessionReconciled,
  recordSessionOwnerRow,
  touchSessionOwnerRow,
  STATE_DB_SCHEMA_VERSION,
} from './state-db.ts';

type MasterRow = { sql: string };
type PrincipalRow = { id: string; kind: string };

function schemaSql(database: Database): string | undefined {
  return database.query<MasterRow, []>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='principals'"
  ).get()?.sql;
}

function journalMode(database: Database): string {
  return (database.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
}

function userVersion(database: Database): number {
  return (database.query('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/** Exact DDL from state-db.ts BEFORE the 'channel' -> 'portal' rename (0.12.x on-disk shape). */
function buildOldDb(dbPath: string): void {
  const d = new Database(dbPath, { create: true });
  d.exec(`
    CREATE TABLE IF NOT EXISTS principals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('channel', 'direct')),
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  d.exec(`
    INSERT INTO principals (id, kind, label, token_hash, enabled, created_at)
    VALUES ('chan1', 'channel', 'chan1', 'aabbcc', 1, 1000),
           ('dir1',  'direct',  'dir1',  'ddeeff', 1, 2000);
  `);
  d.close();
}

/**
 * A 0.12.x DB whose sqlite_master migration already ran (new CHECK
 * constraint already in place) but which was never stamped with a
 * user_version — the "already-rewritten" upgrader state (assessment risk 2).
 */
function buildAlreadyRewrittenDb(dbPath: string): void {
  const d = new Database(dbPath, { create: true });
  d.exec(`
    CREATE TABLE IF NOT EXISTS principals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('portal', 'direct')),
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  d.exec(`
    INSERT INTO principals (id, kind, label, token_hash, enabled, created_at)
    VALUES ('p1', 'portal', 'p1', 'aaa', 1, 1);
  `);
  d.close();
}

describe('state-db — configureStateDatabase', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-state-db-test-'));
    dbPath = join(tmpDir, 'state.db');
  });

  it('fresh DB: creates schema, enables WAL, stamps user_version = STATE_DB_SCHEMA_VERSION', () => {
    const database = new Database(dbPath, { create: true });
    configureStateDatabase(database);

    expect(journalMode(database)).toBe('wal');
    expect(userVersion(database)).toBe(STATE_DB_SCHEMA_VERSION);
    expect(userVersion(database)).toBe(STATE_DB_SCHEMA_VERSION);

    const sql = schemaSql(database);
    expect(sql).toBeDefined();
    expect(sql).toContain("'portal'");
    expect(sql).toContain("'direct'");

    database.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('0.12.x old-constraint DB: migrates channel→portal rows and stamps the current schema version', () => {
    buildOldDb(dbPath);
    const database = new Database(dbPath);
    configureStateDatabase(database);

    const rows = database.query<PrincipalRow, []>('SELECT id, kind FROM principals ORDER BY id').all();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === 'chan1')?.kind).toBe('portal');
    expect(rows.find((r) => r.id === 'dir1')?.kind).toBe('direct');

    expect(userVersion(database)).toBe(STATE_DB_SCHEMA_VERSION);
    expect(schemaSql(database)).not.toContain("'channel'");

    database.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('0.12.x already-rewritten DB at user_version 0: stamped to the current version without data loss', () => {
    buildAlreadyRewrittenDb(dbPath);
    const database = new Database(dbPath);
    // Sanity: this fixture starts at user_version 0 despite the new schema
    // already being in place (the exact upgrader state assessment risk 2 warns about).
    expect(userVersion(database)).toBe(0);

    configureStateDatabase(database);

    const rows = database.query<PrincipalRow, []>('SELECT id, kind FROM principals').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('p1');
    expect(rows[0].kind).toBe('portal');
    expect(userVersion(database)).toBe(STATE_DB_SCHEMA_VERSION);

    database.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('re-running configureStateDatabase on a current DB is a no-op (idempotent re-boot)', () => {
    let database = new Database(dbPath, { create: true });
    configureStateDatabase(database);
    database.exec(`
      INSERT INTO principals (id, kind, label, token_hash, enabled, created_at)
      VALUES ('p1', 'portal', 'p1', 'aaa', 1, 1);
    `);
    const firstSchema = schemaSql(database);
    const firstRows = database.query<PrincipalRow, []>('SELECT id, kind FROM principals ORDER BY id').all();
    const firstVersion = userVersion(database);
    database.close();

    database = new Database(dbPath);
    configureStateDatabase(database);
    const secondSchema = schemaSql(database);
    const secondRows = database.query<PrincipalRow, []>('SELECT id, kind FROM principals ORDER BY id').all();
    const secondVersion = userVersion(database);
    database.close();

    expect(secondSchema).toBe(firstSchema);
    expect(secondRows).toEqual(firstRows);
    expect(secondVersion).toBe(firstVersion);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails closed when user_version is newer than the code', () => {
    const database = new Database(dbPath, { create: true });
    configureStateDatabase(database);
    database.exec('PRAGMA user_version = 99');

    expect(() => configureStateDatabase(database)).toThrow(/user_version|newer/);
    // No write occurred: the future version stamp is untouched (not rolled
    // back to some other value, not advanced).
    expect(userVersion(database)).toBe(99);

    database.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('DB file and -wal/-shm sidecars are 0600 after configuration + a write', () => {
    const database = new Database(dbPath, { create: true });
    configureStateDatabase(database);
    database.exec(`
      INSERT INTO principals (id, kind, label, token_hash, enabled, created_at)
      VALUES ('p1', 'portal', 'p1', 'aaa', 1, 1);
    `);

    expect(statSync(dbPath).mode & 0o777).toBe(0o600);

    const walPath = `${dbPath}-wal`;
    // WAL mode => a write creates the -wal sidecar, making this assertion
    // non-vacuous (there is nothing to check the mode of if it never appears).
    expect(existsSync(walPath)).toBe(true);
    expect(statSync(walPath).mode & 0o777).toBe(0o600);

    const shmPath = `${dbPath}-shm`;
    if (existsSync(shmPath)) {
      expect(statSync(shmPath).mode & 0o777).toBe(0o600);
    }

    database.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the /oc ownership tables (session_owners, permission_owners) on a fresh DB', () => {
    const database = new Database(dbPath, { create: true });
    configureStateDatabase(database);
    const tables = database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    expect(tables).toContain('session_owners');
    expect(tables).toContain('permission_owners');
    expect(userVersion(database)).toBe(STATE_DB_SCHEMA_VERSION);
    database.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the session_eviction_log table (S4, #581 finding #7) on a fresh DB', () => {
    const database = new Database(dbPath, { create: true });
    configureStateDatabase(database);
    const tables = database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    expect(tables).toContain('session_eviction_log');
    expect(userVersion(database)).toBe(STATE_DB_SCHEMA_VERSION);
    database.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migrates a v2 ownership-only DB up to the eviction-log schema without data loss', () => {
    // A pre-eviction-log v2 DB: ownership tables present, stamped user_version = 2.
    const seed = new Database(dbPath, { create: true });
    seed.exec(`
      CREATE TABLE principals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('portal', 'direct')),
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE session_owners (
        session_id TEXT PRIMARY KEY,
        principal_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE permission_owners (
        request_id TEXT PRIMARY KEY,
        principal_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO session_owners (session_id, principal_key, created_at) VALUES ('ses_v2', 'p1', 5);
      PRAGMA user_version = 2;
    `);
    seed.close();

    const database = new Database(dbPath);
    configureStateDatabase(database);
    const tables = database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    expect(tables).toContain('session_eviction_log');
    expect(userVersion(database)).toBe(STATE_DB_SCHEMA_VERSION);
    // Pre-existing ownership data survives the migration.
    expect(database.query('SELECT principal_key FROM session_owners WHERE session_id = ?').get('ses_v2')).toEqual({
      principal_key: 'p1',
    });
    database.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migrates a v3 DB (pre-last_used_at) up to schema v4: backfills last_used_at from created_at, preserves the eviction log (#586)', () => {
    // A pre-last_used_at v3 DB: the exact DDL from BEFORE this change, stamped
    // user_version = 3, seeded with a session_owners row (data-preservation
    // precedent of the v1/v2 migration tests above) AND a session_eviction_log
    // row, so both tables' data-preservation survives the v3→v4 step.
    const seed = new Database(dbPath, { create: true });
    seed.exec(`
      CREATE TABLE principals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('portal', 'direct')),
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE session_owners (
        session_id TEXT PRIMARY KEY,
        principal_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX session_owners_principal ON session_owners(principal_key);
      CREATE TABLE permission_owners (
        request_id TEXT PRIMARY KEY,
        principal_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE session_eviction_log (
        session_id TEXT PRIMARY KEY,
        principal_key TEXT NOT NULL,
        evicted_at INTEGER NOT NULL,
        reconciled_at INTEGER
      );
      CREATE INDEX session_eviction_log_pending ON session_eviction_log(reconciled_at);
      INSERT INTO session_owners (session_id, principal_key, created_at) VALUES ('ses_v3', 'p1', 500);
      INSERT INTO session_eviction_log (session_id, principal_key, evicted_at, reconciled_at)
        VALUES ('ses_evicted', 'p2', 900, NULL);
      PRAGMA user_version = 3;
    `);
    seed.close();

    const database = new Database(dbPath);
    configureStateDatabase(database);

    expect(STATE_DB_SCHEMA_VERSION).toBe(4);
    expect(userVersion(database)).toBe(4);

    const columns = database
      .query<{ name: string }, []>("PRAGMA table_info(session_owners)")
      .all()
      .map((c) => c.name);
    expect(columns).toContain('last_used_at');

    // Backfilled from created_at, not left at the DEFAULT 0.
    const row = database.query('SELECT last_used_at FROM session_owners WHERE session_id = ?').get('ses_v3') as {
      last_used_at: number;
    };
    expect(row.last_used_at).toBe(500);

    // session_eviction_log data survives the migration untouched.
    const logRow = database
      .query('SELECT principal_key, evicted_at, reconciled_at FROM session_eviction_log WHERE session_id = ?')
      .get('ses_evicted');
    expect(logRow).toEqual({ principal_key: 'p2', evicted_at: 900, reconciled_at: null });

    database.close();

    // Idempotent re-run.
    const reopened = new Database(dbPath);
    configureStateDatabase(reopened);
    expect(userVersion(reopened)).toBe(4);
    reopened.close();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fresh-DB and migrated-DB session_owners schemas converge on the same columns (#586)', () => {
    // Fresh-DB path.
    const freshPath = join(tmpDir, 'fresh.db');
    const fresh = new Database(freshPath, { create: true });
    configureStateDatabase(fresh);
    const freshColumns = fresh
      .query<{ name: string }, []>("PRAGMA table_info(session_owners)")
      .all()
      .map((c) => c.name)
      .sort();
    fresh.close();

    // Migrated-DB path: a bare v0 DB (no tables at all) runs every migration
    // step in one pass, including the v1→v2 step that creates session_owners
    // — createOwnershipTables is reused as BOTH that step and the
    // unconditional configure-time CREATE, so this exercises the exact "v3→v4
    // ALTER runs against a table that already has the column" case the sniff
    // guard must no-op on.
    const migrated = new Database(dbPath, { create: true });
    configureStateDatabase(migrated);
    const migratedColumns = migrated
      .query<{ name: string }, []>("PRAGMA table_info(session_owners)")
      .all()
      .map((c) => c.name)
      .sort();
    migrated.close();

    expect(migratedColumns).toEqual(freshColumns);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migrates a v1 principals-only DB up to the ownership schema without data loss', () => {
    // A pre-ownership v1 DB: principals present, stamped user_version = 1, no owner tables.
    const seed = new Database(dbPath, { create: true });
    seed.exec(`
      CREATE TABLE principals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('portal', 'direct')),
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO principals (id, kind, label, token_hash, enabled, created_at)
        VALUES ('p1', 'portal', 'p1', 'aaa', 1, 1);
      PRAGMA user_version = 1;
    `);
    seed.close();

    const database = new Database(dbPath);
    configureStateDatabase(database);
    const tables = database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    expect(tables).toContain('session_owners');
    expect(tables).toContain('permission_owners');
    expect(userVersion(database)).toBe(STATE_DB_SCHEMA_VERSION);
    // Principal data preserved across the migration.
    const rows = database.query<PrincipalRow, []>('SELECT id FROM principals').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('p1');
    database.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('session/permission ownership rows survive a DB reopen (restart survival — bug #1)', () => {
    const first = new Database(dbPath, { create: true });
    configureStateDatabase(first);
    first
      .query('INSERT INTO session_owners (session_id, principal_key, created_at) VALUES (?, ?, ?)')
      .run('ses_1', 'principal-A', 1);
    first
      .query('INSERT INTO permission_owners (request_id, principal_key, created_at) VALUES (?, ?, ?)')
      .run('per_1', 'principal-A', 1);
    first.close();

    // Reopen the same file — a guardian "restart". Ownership MUST persist: it used
    // to live in in-memory Maps that reset on restart, orphaning live sessions
    // (every follow-up call 403'd forbidden_session).
    const second = new Database(dbPath);
    configureStateDatabase(second);
    expect(second.query('SELECT principal_key FROM session_owners WHERE session_id = ?').get('ses_1')).toEqual({
      principal_key: 'principal-A',
    });
    expect(second.query('SELECT principal_key FROM permission_owners WHERE request_id = ?').get('per_1')).toEqual({
      principal_key: 'principal-A',
    });
    second.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // deletePrincipal (the new accessor added alongside configureStateDatabase)
  // is intentionally NOT unit-tested here: it goes through the module
  // singleton (openDatabase()), which — per the module-cache-bleed constraint
  // documented above — is unsafe to exercise across test files in-process.
  // Its contract is covered end-to-end via the admin API in
  // proxy-direct.test.ts (DELETE /admin/principals/:id).
});

/**
 * S4 (#581 finding #7) — orphan reconciliation.
 *
 * recordSessionOwnerRow / listPendingEvictedSessions / markSessionReconciled /
 * countPendingEvictedSessions all accept an explicit `database` (and, for
 * recordSessionOwnerRow, `maxRows`) argument defaulting to the module
 * singleton — the SAME test seam configureStateDatabase already uses, so
 * these tests drive a raw temp-file Database directly rather than the
 * env-bound singleton (unsafe to exercise across test files, see above).
 *
 * Before this fix, evicting a session_owners row past the bounded cap simply
 * deleted it: the underlying OpenCode session stayed durable upstream with NO
 * owner, GET /session (filtered to owned rows) could never show it again to
 * any principal, and DELETE /session/{id} would 403 forbidden_session — a
 * permanent, undeletable orphan. Eviction must now persist a
 * session_eviction_log row for every evicted session_id so an async sweep
 * (reconciliation.ts) can still delete/archive it upstream.
 */
describe('session_owners eviction persists a reconciliation record (S4, #581 finding #7)', () => {
  let tmpDir: string;
  let dbPath: string;
  let database: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-eviction-test-'));
    dbPath = join(tmpDir, 'state.db');
    database = new Database(dbPath, { create: true });
    configureStateDatabase(database);
  });

  function sessionOwnerIds(): string[] {
    return (database.query('SELECT session_id FROM session_owners ORDER BY session_id').all() as { session_id: string }[]).map(
      (r) => r.session_id,
    );
  }

  it('recording rows at or under the cap evicts nothing and logs nothing', () => {
    for (let i = 0; i < 3; i++) {
      recordSessionOwnerRow(`ses_${i}`, 'p1', i, database, /* maxRows */ 3);
    }
    expect(sessionOwnerIds()).toEqual(['ses_0', 'ses_1', 'ses_2']);
    expect(listPendingEvictedSessions(100, database)).toEqual([]);
    expect(countPendingEvictedSessions(database)).toBe(0);
  });

  it('recording a row past the cap evicts the OLDEST owner row and records it as a pending reconciliation', () => {
    for (let i = 0; i < 4; i++) {
      recordSessionOwnerRow(`ses_${i}`, 'p1', i, database, /* maxRows */ 3);
    }
    // ses_0 (oldest by created_at) was evicted from session_owners...
    expect(sessionOwnerIds()).toEqual(['ses_1', 'ses_2', 'ses_3']);
    // ...but NOT silently dropped: a pending reconciliation record survives it.
    const pending = listPendingEvictedSessions(100, database);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.sessionId).toBe('ses_0');
    expect(pending[0]?.principalKey).toBe('p1');
    expect(typeof pending[0]?.evictedAt).toBe('number');
    expect(countPendingEvictedSessions(database)).toBe(1);
  });

  it('evicting multiple rows in one insert (cap dropped) logs every evicted session, oldest first', () => {
    for (let i = 0; i < 3; i++) {
      recordSessionOwnerRow(`ses_${i}`, 'p1', i, database, /* maxRows */ 3);
    }
    // Now retroactively shrink the cap to 1 on the next insert: 3 rows must evict.
    recordSessionOwnerRow('ses_3', 'p1', 3, database, /* maxRows */ 1);
    expect(sessionOwnerIds()).toEqual(['ses_3']);
    const pending = listPendingEvictedSessions(100, database).map((r) => r.sessionId);
    expect(pending).toEqual(['ses_0', 'ses_1', 'ses_2']);
  });

  it('markSessionReconciled clears a row from the pending list without deleting the log row', () => {
    for (let i = 0; i < 4; i++) {
      recordSessionOwnerRow(`ses_${i}`, 'p1', i, database, /* maxRows */ 3);
    }
    expect(countPendingEvictedSessions(database)).toBe(1);

    markSessionReconciled('ses_0', database);

    expect(listPendingEvictedSessions(100, database)).toEqual([]);
    expect(countPendingEvictedSessions(database)).toBe(0);
    // The row itself still exists (reconciled_at set), not deleted outright —
    // an audit trail of what was reconciled, not just what is still pending.
    const row = database.query('SELECT reconciled_at FROM session_eviction_log WHERE session_id = ?').get('ses_0') as
      | { reconciled_at: number | null }
      | null;
    expect(row).not.toBeNull();
    expect(row?.reconciled_at).not.toBeNull();
  });

  it('re-evicting a session_id already pending in the log refreshes it rather than erroring (ON CONFLICT)', () => {
    for (let i = 0; i < 4; i++) {
      recordSessionOwnerRow(`ses_${i}`, 'p1', i, database, /* maxRows */ 3);
    }
    markSessionReconciled('ses_0', database);
    // ses_0 is now reconciled and gone from session_owners. If a session id
    // were ever reused (should not happen with OpenCode ids, but a defensive
    // re-eviction must not throw) and immediately evicted again — created_at
    // -1 makes it the oldest row so this single insert evicts it right back
    // out — the log row must flip back to PENDING under the new owner,
    // rather than silently staying "reconciled" forever (which would let the
    // async sweep skip a session that needs deleting again).
    recordSessionOwnerRow('ses_0', 'p2', -1, database, /* maxRows */ 3);
    const pending = listPendingEvictedSessions(100, database);
    expect(pending.some((r) => r.sessionId === 'ses_0' && r.principalKey === 'p2')).toBe(true);
  });

  it('the eviction log NEVER drops a pending row: reconciled rows are pruned first, pending rows survive even over cap (S4 Fix B, #586)', () => {
    // Evict 5 sessions (cap 1 keeps only the newest owner row); reconcile 3 of
    // them, then force the eviction-log cap down to 2 via a further eviction.
    for (let i = 0; i < 6; i++) {
      recordSessionOwnerRow(`ses_${i}`, 'p1', i, database, /* maxRows */ 1);
    }
    const evicted = listPendingEvictedSessions(100, database).map((r) => r.sessionId);
    expect(evicted).toEqual(['ses_0', 'ses_1', 'ses_2', 'ses_3', 'ses_4']);
    markSessionReconciled('ses_0', database);
    markSessionReconciled('ses_1', database);
    markSessionReconciled('ses_2', database);

    // One more eviction, with the eviction-log cap constrained to 2 rows.
    // This USED to pin defect B: the old prune order (reconciled-first, then
    // oldest-pending) dropped ses_3 (a still-PENDING row) to hit the cap
    // exactly. Under the fix, pruneEvictionLog's candidate set is
    // reconciled-only — pending rows are structurally unreachable — so ALL
    // THREE already-reconciled rows are pruned (even though that leaves 3
    // pending rows over the cap of 2) and NONE of ses_3/ses_4/the
    // freshly-evicted ses_5 is ever dropped.
    recordSessionOwnerRow('ses_6', 'p1', 6, database, /* maxRows */ 1, /* evictionLogMaxRows */ 2);

    const allLogRows = database
      .query('SELECT session_id, reconciled_at FROM session_eviction_log ORDER BY session_id')
      .all() as { session_id: string; reconciled_at: number | null }[];
    expect(allLogRows.map((r) => r.session_id)).toEqual(['ses_3', 'ses_4', 'ses_5']);
    for (const row of allLogRows) {
      expect(row.reconciled_at).toBeNull();
    }
  });

  it('touching an old row lets it survive an eviction that would otherwise take it (Fix A, #586)', () => {
    recordSessionOwnerRow('ses_0', 'p1', 0, database, /* maxRows */ 3);
    recordSessionOwnerRow('ses_1', 'p1', 1, database, 3);
    recordSessionOwnerRow('ses_2', 'p1', 2, database, 3);
    // Refresh ses_0's last_used_at to "now" — WAY more recent than ses_1/ses_2's
    // tiny createdAt-derived values.
    touchSessionOwnerRow('ses_0', Date.now(), database);
    // A 4th row crosses the cap: without the touch, ses_0 (oldest by
    // created_at) would be evicted; with it, ses_1 is now the oldest by
    // last_used_at instead.
    recordSessionOwnerRow('ses_3', 'p1', 3, database, 3);

    expect(sessionOwnerIds()).toEqual(['ses_0', 'ses_2', 'ses_3']);
    const pending = listPendingEvictedSessions(100, database).map((r) => r.sessionId);
    expect(pending).toEqual(['ses_1']);
  });

  it('recordSessionOwnerRow refreshes last_used_at on an ON CONFLICT re-insert', () => {
    recordSessionOwnerRow('ses_a', 'p1', 0, database, /* maxRows */ 100);
    recordSessionOwnerRow('ses_a', 'p1', 5000, database, 100);
    const row = database.query('SELECT last_used_at FROM session_owners WHERE session_id = ?').get('ses_a') as {
      last_used_at: number;
    };
    expect(row.last_used_at).toBe(5000);
  });

  it('active-grace soft cap: rows all within grace are never evicted even though the table exceeds the cap (Fix A step 3, #586)', () => {
    const graceMs = 100;
    // 4 rows, cap 3. last_used_at = createdAt (recordSessionOwnerRow's own
    // write semantics) — small, closely-spaced values relative to a MUCH
    // bigger grace window, so every row is still "in grace" at the final
    // insert's cutoff (40 - 100 = -60): none are stale, so the cap is
    // exceeded but nothing is evicted (never-delete-user-data outranks table
    // hygiene).
    recordSessionOwnerRow('ses_0', 'p1', 10, database, /* maxRows */ 3, /* evictionLogMaxRows */ 100, graceMs, 10);
    recordSessionOwnerRow('ses_1', 'p1', 20, database, 3, 100, graceMs, 20);
    recordSessionOwnerRow('ses_2', 'p1', 30, database, 3, 100, graceMs, 30);
    recordSessionOwnerRow('ses_3', 'p1', 40, database, 3, 100, graceMs, 40);

    expect(sessionOwnerIds()).toEqual(['ses_0', 'ses_1', 'ses_2', 'ses_3']);
    expect(listPendingEvictedSessions(100, database)).toEqual([]);
  });

  it('active-grace soft cap: exactly the row that ages out of grace evicts, others in grace survive (Fix A step 3, #586)', () => {
    const graceMs = 15;
    recordSessionOwnerRow('ses_0', 'p1', 0, database, /* maxRows */ 3, /* evictionLogMaxRows */ 100, graceMs, 0);
    recordSessionOwnerRow('ses_1', 'p1', 190, database, 3, 100, graceMs, 190);
    recordSessionOwnerRow('ses_2', 'p1', 195, database, 3, 100, graceMs, 195);
    // Triggering insert at now=200: cutoff = 200-15 = 185. Only ses_0 (0) is
    // <= 185; ses_1 (190) and ses_2 (195) are both still within grace.
    recordSessionOwnerRow('ses_3', 'p1', 200, database, 3, 100, graceMs, 200);

    expect(sessionOwnerIds()).toEqual(['ses_1', 'ses_2', 'ses_3']);
    const pending = listPendingEvictedSessions(100, database).map((r) => r.sessionId);
    expect(pending).toEqual(['ses_0']);
  });

  it('a touched (active) session never appears in the eviction log across repeated cap-crossings (AC1, #586)', () => {
    const graceMs = 50;
    let clock = 0;
    recordSessionOwnerRow('kept_alive', 'p1', clock, database, /* maxRows */ 2, /* evictionLogMaxRows */ 1000, graceMs, clock);

    for (let i = 0; i < 20; i++) {
      clock += 100; // well past the 50ms grace window each iteration
      touchSessionOwnerRow('kept_alive', clock, database); // refresh right before the crossing
      recordSessionOwnerRow(`ses_${i}`, 'p1', clock, database, 2, 1000, graceMs, clock);
    }

    expect(sessionOwnerIds()).toContain('kept_alive');
    const everLogged = database
      .query('SELECT 1 AS x FROM session_eviction_log WHERE session_id = ?')
      .get('kept_alive');
    expect(everLogged).toBeNull();
  });
});

describe('_clampEvictionLogMaxRows — malformed GUARDIAN_EVICTION_LOG_MAX_ROWS overrides', () => {
  it('accepts a plain positive integer', () => {
    expect(_clampEvictionLogMaxRows('50')).toBe(50);
  });

  it('rejects zero, negatives, and non-numeric strings, defaulting to 10000', () => {
    expect(_clampEvictionLogMaxRows('0')).toBe(10_000);
    expect(_clampEvictionLogMaxRows('-5')).toBe(10_000);
    expect(_clampEvictionLogMaxRows('all')).toBe(10_000);
    expect(_clampEvictionLogMaxRows(undefined)).toBe(10_000);
  });
});

describe('_clampOwnershipMaxRows — malformed GUARDIAN_OWNERSHIP_MAX_ROWS overrides', () => {
  // A bad value here is catastrophic: NaN binds to SQLite as NULL and turns
  // evictOldestSessionOwners/evictOldestPermissionOwners' `LIMIT MAX(0, count - ?)`
  // unbounded; a clamp result of 0
  // makes the limit `count - 0` — either way the ENTIRE ownership table is
  // deleted on the next insert. The clamp must reject every such shape.
  it('accepts a plain positive integer', () => {
    expect(_clampOwnershipMaxRows('50')).toBe(50);
  });

  it('floors a fractional value >= 1', () => {
    expect(_clampOwnershipMaxRows('12.9')).toBe(12);
  });

  it('rejects a fractional value in (0, 1) — floors to 0, which would wipe the table', () => {
    expect(_clampOwnershipMaxRows('0.5')).toBe(10_000);
  });

  it('rejects zero, negatives, and non-numeric strings', () => {
    expect(_clampOwnershipMaxRows('0')).toBe(10_000);
    expect(_clampOwnershipMaxRows('-5')).toBe(10_000);
    expect(_clampOwnershipMaxRows('all')).toBe(10_000);
    expect(_clampOwnershipMaxRows('Infinity')).toBe(10_000);
  });

  it('defaults to 10000 when unset (empty string coerces to 0 → rejected too)', () => {
    expect(_clampOwnershipMaxRows(undefined)).toBe(10_000);
    expect(_clampOwnershipMaxRows('')).toBe(10_000);
  });
});
