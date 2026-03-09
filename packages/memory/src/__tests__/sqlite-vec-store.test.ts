import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SqliteVecStore } from '../vector-stores/sqlite-vec.js';
import { unlinkSync, existsSync } from 'node:fs';

const TEST_DB = '/tmp/test-sqlite-vec.db';

function cleanup() {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

describe('SqliteVecStore', () => {
  let store: SqliteVecStore;

  beforeEach(async () => {
    cleanup();
    store = new SqliteVecStore({
      dbPath: TEST_DB,
      collectionName: 'test',
      dimensions: 4,
    });
    await store.initialize();
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  test('constructor validates collection name', () => {
    expect(() => new SqliteVecStore({
      dbPath: TEST_DB,
      collectionName: 'drop table;--',
      dimensions: 4,
    })).toThrow('Invalid collection name');
  });

  test('accepts valid collection names', () => {
    const s = new SqliteVecStore({
      dbPath: ':memory:',
      collectionName: 'my_collection_2',
      dimensions: 4,
    });
    s.close();
  });

  test('insert and get', async () => {
    const vector = [1, 0, 0, 0];
    const payload = {
      user_id: 'user1',
      agent_id: null,
      run_id: null,
      hash: 'abc123',
      data: 'test fact',
      metadata: { source: 'test' },
    };

    await store.insert([vector], ['id1'], [payload]);

    const result = await store.get('id1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('id1');
    expect(result!.payload.data).toBe('test fact');
    expect(result!.payload.user_id).toBe('user1');
    expect(result!.payload.hash).toBe('abc123');
  });

  test('get returns null for missing ID', async () => {
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });

  test('search returns results sorted by similarity', async () => {
    const payloadBase = {
      user_id: 'user1',
      agent_id: null,
      run_id: null,
      hash: null,
      metadata: {},
    };

    await store.insert(
      [[1, 0, 0, 0], [0, 1, 0, 0], [0.9, 0.1, 0, 0]],
      ['a', 'b', 'c'],
      [
        { ...payloadBase, data: 'closest' },
        { ...payloadBase, data: 'far' },
        { ...payloadBase, data: 'near' },
      ],
    );

    const results = await store.search([1, 0, 0, 0], 2);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe('a');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  test('search filters by userId', async () => {
    const payload = (uid: string) => ({
      user_id: uid,
      agent_id: null,
      run_id: null,
      hash: null,
      data: 'test',
      metadata: {},
    });

    await store.insert(
      [[1, 0, 0, 0], [0.9, 0.1, 0, 0]],
      ['a', 'b'],
      [payload('alice'), payload('bob')],
    );

    const results = await store.search([1, 0, 0, 0], 10, { userId: 'alice' });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('a');
  });

  test('update changes data and vector', async () => {
    const payload = {
      user_id: 'user1',
      agent_id: null,
      run_id: null,
      hash: 'h1',
      data: 'original',
      metadata: {},
    };

    await store.insert([[1, 0, 0, 0]], ['id1'], [payload]);
    await store.update('id1', [0, 1, 0, 0], {
      ...payload,
      data: 'updated',
      hash: 'h2',
    });

    const result = await store.get('id1');
    expect(result!.payload.data).toBe('updated');
    expect(result!.payload.hash).toBe('h2');
  });

  test('delete removes item', async () => {
    const payload = {
      user_id: 'user1',
      agent_id: null,
      run_id: null,
      hash: null,
      data: 'test',
      metadata: {},
    };

    await store.insert([[1, 0, 0, 0]], ['id1'], [payload]);
    await store.delete('id1');

    const result = await store.get('id1');
    expect(result).toBeNull();
  });

  test('list returns all items with count', async () => {
    const payload = (uid: string) => ({
      user_id: uid,
      agent_id: null,
      run_id: null,
      hash: null,
      data: 'test',
      metadata: {},
    });

    await store.insert(
      [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
      ['a', 'b', 'c'],
      [payload('alice'), payload('alice'), payload('bob')],
    );

    const [all, totalAll] = await store.list();
    expect(all.length).toBe(3);
    expect(totalAll).toBe(3);

    const [filtered, totalFiltered] = await store.list({ userId: 'alice' });
    expect(filtered.length).toBe(2);
    expect(totalFiltered).toBe(2);
  });

  test('list respects limit', async () => {
    const payload = {
      user_id: 'user1',
      agent_id: null,
      run_id: null,
      hash: null,
      data: 'test',
      metadata: {},
    };

    await store.insert(
      [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
      ['a', 'b', 'c'],
      [payload, payload, payload],
    );

    const [items, total] = await store.list(undefined, 2);
    expect(items.length).toBe(2);
    expect(total).toBe(3);
  });

  test('deleteCol clears all data and reinitializes', async () => {
    const payload = {
      user_id: 'user1',
      agent_id: null,
      run_id: null,
      hash: null,
      data: 'test',
      metadata: {},
    };

    await store.insert([[1, 0, 0, 0]], ['id1'], [payload]);
    await store.deleteCol();

    const result = await store.get('id1');
    expect(result).toBeNull();

    // Can still insert after deleteCol
    await store.insert([[1, 0, 0, 0]], ['id2'], [payload]);
    const result2 = await store.get('id2');
    expect(result2).not.toBeNull();
  });

  test('getDb returns the database instance', () => {
    const db = store.getDb();
    expect(db).toBeDefined();
  });
});
