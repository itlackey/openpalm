import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SqliteHistoryManager } from '../storage/sqlite.js';
import { createHistoryManager } from '../storage/index.js';
import { Database } from 'bun:sqlite';
import { unlinkSync, existsSync } from 'node:fs';

const TEST_DB = '/tmp/test-history.db';

function cleanup() {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

describe('SqliteHistoryManager', () => {
  let mgr: SqliteHistoryManager;

  beforeEach(() => {
    cleanup();
    mgr = new SqliteHistoryManager(TEST_DB);
  });

  afterEach(() => {
    mgr.close();
    cleanup();
  });

  test('addHistory and getHistory', async () => {
    await mgr.addHistory('mem1', null, 'new value', 'ADD');

    const history = await mgr.getHistory('mem1');
    expect(history.length).toBe(1);
    expect(history[0].memoryId).toBe('mem1');
    expect(history[0].newValue).toBe('new value');
    expect(history[0].previousValue).toBeNull();
    expect(history[0].action).toBe('ADD');
  });

  test('records multiple entries in order', async () => {
    await mgr.addHistory('mem1', null, 'v1', 'ADD');
    await mgr.addHistory('mem1', 'v1', 'v2', 'UPDATE');

    const history = await mgr.getHistory('mem1');
    expect(history.length).toBe(2);
    expect(history[0].action).toBe('ADD');
    expect(history[1].action).toBe('UPDATE');
    expect(history[1].previousValue).toBe('v1');
    expect(history[1].newValue).toBe('v2');
  });

  test('getHistory returns empty array for unknown memoryId', async () => {
    const history = await mgr.getHistory('nonexistent');
    expect(history).toEqual([]);
  });

  test('reset clears all history', async () => {
    await mgr.addHistory('mem1', null, 'v1', 'ADD');
    await mgr.addHistory('mem2', null, 'v2', 'ADD');

    await mgr.reset();

    expect(await mgr.getHistory('mem1')).toEqual([]);
    expect(await mgr.getHistory('mem2')).toEqual([]);
  });

  test('shared Database instance (ownsDb=false)', () => {
    const db = new Database(':memory:');
    const shared = new SqliteHistoryManager(db);

    // Should not close the DB when shared manager closes
    shared.close();

    // DB should still be usable
    expect(() => db.exec('SELECT 1')).not.toThrow();
    db.close();
  });
});

describe('createHistoryManager', () => {
  test('returns null for null input', () => {
    expect(createHistoryManager(null)).toBeNull();
  });

  test('returns null for undefined input', () => {
    expect(createHistoryManager(undefined)).toBeNull();
  });

  test('returns SqliteHistoryManager for string path', () => {
    cleanup();
    const mgr = createHistoryManager(TEST_DB);
    expect(mgr).not.toBeNull();
    expect(mgr).toBeInstanceOf(SqliteHistoryManager);
    mgr!.close();
    cleanup();
  });

  test('returns SqliteHistoryManager for Database instance', () => {
    const db = new Database(':memory:');
    const mgr = createHistoryManager(db);
    expect(mgr).not.toBeNull();
    expect(mgr).toBeInstanceOf(SqliteHistoryManager);
    mgr!.close();
    db.close();
  });
});
