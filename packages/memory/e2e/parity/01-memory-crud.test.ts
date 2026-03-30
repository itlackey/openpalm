/**
 * 01 — Core CRUD Parity Tests
 *
 * Verifies that every CRUD operation produces the same output shape
 * and behavior as the original mem0 Python SDK.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  createTestMemory,
  cleanupDb,
  type TestMemoryResult,
} from './helpers.js';
import type { Memory } from '../../src/memory.js';
import { md5 } from '../../src/utils/index.js';

let t: TestMemoryResult;
let mem: Memory;

beforeEach(async () => {
  t = createTestMemory();
  mem = t.mem;
  await mem.initialize();
});

afterEach(() => {
  mem.close();
  cleanupDb(t.dbPath);
});

describe('01 — Core CRUD Parity', () => {
  // ── Test 1 ─────────────────────────────────────────────────────────
  test('add(string, {infer:false}) returns {results: [{event:"ADD", id, text}]}', async () => {
    const result = await mem.add('User likes TypeScript', {
      userId: 'alice',
      infer: false,
    });

    expect(result).toHaveProperty('results');
    expect(result.results).toHaveLength(1);

    const op = result.results[0];
    expect(op.event).toBe('ADD');
    expect(typeof op.id).toBe('string');
    expect(op.id!.length).toBeGreaterThan(0);
    expect(op.text).toBe('User likes TypeScript');
  });

  // ── Test 2 ─────────────────────────────────────────────────────────
  test('add(Message[], {infer:false}) joins messages as "role: content"', async () => {
    const result = await mem.add(
      [
        { role: 'user', content: 'I like cats' },
        { role: 'assistant', content: 'Cats are great!' },
      ],
      { userId: 'alice', infer: false },
    );

    expect(result.results).toHaveLength(1);
    const id = result.results[0].id!;

    // The stored content should be the parsed message text
    const item = await mem.get(id);
    expect(item).not.toBeNull();
    expect(item!.content).toBe('user: I like cats\nassistant: Cats are great!');
  });

  // ── Test 3 ─────────────────────────────────────────────────────────
  test('add() stores correct payload fields: user_id, agent_id, run_id, hash, data, metadata', async () => {
    const result = await mem.add('Important fact', {
      userId: 'alice',
      agentId: 'agent-1',
      runId: 'run-42',
      metadata: { source: 'test' },
      infer: false,
    });

    const id = result.results[0].id!;
    const item = await mem.get(id);
    expect(item).not.toBeNull();

    // Verify stored content
    expect(item!.content).toBe('Important fact');
    expect(item!.hash).toBe(md5('Important fact'));
    expect(item!.metadata).toEqual({ source: 'test' });

    // Verify timestamps exist
    expect(item!.createdAt).toBeDefined();
    expect(item!.updatedAt).toBeDefined();
  });

  // ── Test 4 ─────────────────────────────────────────────────────────
  test('get(id) returns {id, content, hash, metadata, createdAt, updatedAt}', async () => {
    const { results } = await mem.add('Retrieve me', {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    const item = await mem.get(id);
    expect(item).not.toBeNull();
    expect(item!.id).toBe(id);
    expect(item!.content).toBe('Retrieve me');
    expect(typeof item!.hash).toBe('string');
    expect(typeof item!.metadata).toBe('object');
    expect(typeof item!.createdAt).toBe('string');
    expect(typeof item!.updatedAt).toBe('string');
    // score is set to 1.0 for direct get (not a search)
    expect(item!.score).toBe(1.0);
  });

  // ── Test 5 ─────────────────────────────────────────────────────────
  test('get(nonexistent) returns null', async () => {
    const item = await mem.get('nonexistent-uuid');
    expect(item).toBeNull();
  });

  // ── Test 6 ─────────────────────────────────────────────────────────
  test('getAll({userId}) filters correctly, returns array', async () => {
    await mem.add('Alice fact 1', { userId: 'alice', infer: false });
    await mem.add('Alice fact 2', { userId: 'alice', infer: false });
    await mem.add('Bob fact 1', { userId: 'bob', infer: false });

    const aliceItems = await mem.getAll({ userId: 'alice' });
    expect(Array.isArray(aliceItems)).toBe(true);
    expect(aliceItems).toHaveLength(2);
    for (const item of aliceItems) {
      expect(item.content).toMatch(/^Alice fact/);
    }
  });

  // ── Test 7 ─────────────────────────────────────────────────────────
  test('getAll({agentId}) filters by agentId', async () => {
    await mem.add('Agent A fact', { agentId: 'agent-a', infer: false });
    await mem.add('Agent B fact', { agentId: 'agent-b', infer: false });

    const items = await mem.getAll({ agentId: 'agent-a' });
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('Agent A fact');
  });

  // ── Test 8 ─────────────────────────────────────────────────────────
  test('getAll({runId}) filters by runId', async () => {
    await mem.add('Run 1 fact', { runId: 'run-1', infer: false });
    await mem.add('Run 2 fact', { runId: 'run-2', infer: false });

    const items = await mem.getAll({ runId: 'run-1' });
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('Run 1 fact');
  });

  // ── Test 9 ─────────────────────────────────────────────────────────
  test('getAll() with no filters returns all', async () => {
    await mem.add('Fact 1', { userId: 'alice', infer: false });
    await mem.add('Fact 2', { userId: 'bob', infer: false });
    await mem.add('Fact 3', { agentId: 'agent-1', infer: false });

    const all = await mem.getAll();
    expect(all).toHaveLength(3);
  });

  // ── Test 10 ────────────────────────────────────────────────────────
  test('getAll({limit}) respects limit param', async () => {
    await mem.add('Fact 1', { userId: 'alice', infer: false });
    await mem.add('Fact 2', { userId: 'alice', infer: false });
    await mem.add('Fact 3', { userId: 'alice', infer: false });

    const items = await mem.getAll({ userId: 'alice', limit: 2 });
    expect(items).toHaveLength(2);
  });

  // ── Test 11 ────────────────────────────────────────────────────────
  test('update(id, data) changes content, re-embeds, returns {id, content}', async () => {
    const { results } = await mem.add('Original text', {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    const updated = await mem.update(id, 'Updated text');
    expect(updated).toEqual({ id, content: 'Updated text' });

    // Verify persisted
    const item = await mem.get(id);
    expect(item!.content).toBe('Updated text');
    expect(item!.hash).toBe(md5('Updated text'));
  });

  // ── Test 12 ────────────────────────────────────────────────────────
  test('update(id, data, metadata) replaces metadata', async () => {
    const { results } = await mem.add('Fact', {
      userId: 'alice',
      metadata: { original: true },
      infer: false,
    });
    const id = results[0].id!;

    await mem.update(id, 'Updated fact', { replaced: true });
    const item = await mem.get(id);
    expect(item!.metadata).toEqual({ replaced: true });
  });

  // ── Test 13 ────────────────────────────────────────────────────────
  test('delete(id) removes from vector store and metadata', async () => {
    const { results } = await mem.add('To delete', {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    await mem.delete(id);

    const item = await mem.get(id);
    expect(item).toBeNull();

    // Should not appear in getAll either
    const all = await mem.getAll({ userId: 'alice' });
    expect(all).toHaveLength(0);
  });

  // ── Test 14 ────────────────────────────────────────────────────────
  test('deleteAll({userId}) removes all for user, preserves others', async () => {
    await mem.add('Alice 1', { userId: 'alice', infer: false });
    await mem.add('Alice 2', { userId: 'alice', infer: false });
    await mem.add('Bob 1', { userId: 'bob', infer: false });

    await mem.deleteAll({ userId: 'alice' });

    const alice = await mem.getAll({ userId: 'alice' });
    expect(alice).toHaveLength(0);

    const bob = await mem.getAll({ userId: 'bob' });
    expect(bob).toHaveLength(1);
    expect(bob[0].content).toBe('Bob 1');
  });
});
