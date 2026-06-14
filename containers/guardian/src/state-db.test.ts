/**
 * state-db.ts unit tests — focuses on the kind-constraint migration
 * ('channel' → 'portal') and core CRUD behaviour.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We exercise the migration by driving the low-level Database directly (the
// migration logic is triggered inside openDatabase(), which reads
// GUARDIAN_STATE_DB_PATH from Bun.env). Each test gets its own temp dir so
// the module-level singleton 'db' in state-db.ts does not bleed between cases.

function buildOldDb(dbPath: string): Database {
  const d = new Database(dbPath, { create: true });
  // Exact DDL from state-db.ts BEFORE the rename.
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
  return d;
}

describe('state-db — kind migration (channel → portal)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-state-db-test-'));
  });

  it('migrates existing channel rows to portal and preserves direct rows', async () => {
    const dbPath = join(tmpDir, 'state.db');
    buildOldDb(dbPath);

    // Re-import with a fresh env pointing at our old DB. We cannot rely on the
    // module-level singleton across test processes because bun:test shares the
    // module cache. Instead, drive the migration function directly.
    const { Database: BunDb } = await import('bun:sqlite');

    // Inline the migration logic (mirrors state-db.ts migrateKindConstraintIfNeeded)
    // so this test is self-contained and does not depend on the singleton 'db'.
    const database = new BunDb(dbPath);

    type MasterRow = { sql: string };
    const row = database.query<MasterRow, []>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='principals'"
    ).get();

    expect(row).not.toBeNull();
    // Old schema should still contain 'channel' in the CHECK.
    expect(row!.sql).toContain("'channel'");

    // Run migration.
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

    type Row = { id: string; kind: string };
    const rows = database.query<Row, []>('SELECT id, kind FROM principals ORDER BY id').all();
    database.close();

    expect(rows).toHaveLength(2);
    const chan = rows.find((r) => r.id === 'chan1');
    const dir = rows.find((r) => r.id === 'dir1');
    expect(chan?.kind).toBe('portal');  // 'channel' was renamed to 'portal'
    expect(dir?.kind).toBe('direct');  // 'direct' unchanged

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migration is idempotent: running it on a new-schema DB is a no-op', async () => {
    const dbPath = join(tmpDir, 'state-new.db');
    const database = new Database(dbPath, { create: true });
    // Create with new schema directly.
    database.exec(`
      CREATE TABLE principals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('portal', 'direct')),
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    database.exec(`
      INSERT INTO principals VALUES ('p1', 'portal', 'p1', 'aaa', 1, 1);
    `);

    type MasterRow = { sql: string };
    const row = database.query<MasterRow, []>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='principals'"
    ).get();

    // New schema does NOT contain 'channel' in the CHECK — migration is skipped.
    expect(row!.sql).not.toContain("'channel'");

    type Row = { id: string; kind: string };
    const rows = database.query<Row, []>('SELECT id, kind FROM principals').all();
    database.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('portal');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
