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

import { configureStateDatabase, STATE_DB_SCHEMA_VERSION } from './state-db.ts';

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
