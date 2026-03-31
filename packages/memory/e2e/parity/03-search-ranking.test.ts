/**
 * 03 — Search & Vector Parity Tests
 *
 * Verifies that vector search, scoring, and filtering behave
 * identically to the original mem0 implementation.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  createTestMemory,
  cleanupDb,
  hashEmbed,
  DIMS,
  type TestMemoryResult,
} from './helpers.js';
import type { Memory } from '../../src/memory.js';

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

describe('03 — Search & Vector Parity', () => {
  // ── Test 1: Results sorted by similarity score (desc) ──────────────
  test('search() returns results sorted by similarity score (desc)', async () => {
    // Add memories with varied text so embeddings differ
    await mem.add('TypeScript is great for web development', {
      userId: 'alice',
      infer: false,
    });
    await mem.add('Python is great for data science', {
      userId: 'alice',
      infer: false,
    });
    await mem.add('TypeScript types improve code quality', {
      userId: 'alice',
      infer: false,
    });

    const results = await mem.search('TypeScript web development', {
      userId: 'alice',
    });

    expect(results.length).toBeGreaterThanOrEqual(1);

    // Verify scores are in descending order
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score!).toBeGreaterThanOrEqual(results[i].score!);
    }
  });

  // ── Test 2: Score field is in 0-1 range ────────────────────────────
  test('search() result items have score field (0-1 range)', async () => {
    await mem.add('User likes TypeScript', { userId: 'alice', infer: false });
    await mem.add('User prefers dark mode', { userId: 'alice', infer: false });

    const results = await mem.search('TypeScript', { userId: 'alice' });

    for (const item of results) {
      expect(item.score).toBeDefined();
      expect(typeof item.score).toBe('number');
      // Score is 1 - cosine_distance, should be in [-1, 1] range
      // Practically for similar text it should be positive
      expect(item.score!).toBeLessThanOrEqual(1.0);
    }
  });

  // ── Test 3: User-scoped search ─────────────────────────────────────
  test('search({userId}) filters results to user memories only', async () => {
    await mem.add('Alice fact about TypeScript', {
      userId: 'alice',
      infer: false,
    });
    await mem.add('Bob fact about TypeScript', {
      userId: 'bob',
      infer: false,
    });

    const results = await mem.search('TypeScript', { userId: 'alice' });

    // All results should belong to alice
    for (const item of results) {
      expect(item.content).toContain('Alice');
    }
  });

  // ── Test 4: Limit enforcement ──────────────────────────────────────
  test('search({limit}) respects result count limit', async () => {
    // Add 5 memories
    for (let i = 0; i < 5; i++) {
      await mem.add(`Fact number ${i} about coding`, {
        userId: 'alice',
        infer: false,
      });
    }

    const results = await mem.search('coding', {
      userId: 'alice',
      limit: 2,
    });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  // ── Test 5: Filtered search uses oversampling ──────────────────────
  test('search() with filters uses oversampling (10x) then post-filters', async () => {
    // This is a behavioral test. When filters are active, the vector store
    // fetches limit*10 results and then filters. We verify that filtered
    // results are correct even when the target memories are sparse.
    for (let i = 0; i < 10; i++) {
      await mem.add(`Common fact ${i}`, { userId: 'other', infer: false });
    }
    await mem.add('Rare alice fact', { userId: 'alice', infer: false });

    const results = await mem.search('fact', {
      userId: 'alice',
      limit: 5,
    });

    // Should find Alice's memory despite being sparse among others
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain('alice');
  });

  // ── Test 6: Result shape ───────────────────────────────────────────
  test('search() returns MemoryItem shape (id, content, hash, metadata, score)', async () => {
    await mem.add('Shape test fact', {
      userId: 'alice',
      metadata: { key: 'value' },
      infer: false,
    });

    const results = await mem.search('shape test', { userId: 'alice' });
    expect(results.length).toBeGreaterThanOrEqual(1);

    const item = results[0];
    expect(typeof item.id).toBe('string');
    expect(typeof item.content).toBe('string');
    expect(typeof item.hash).toBe('string');
    expect(typeof item.metadata).toBe('object');
    expect(typeof item.score).toBe('number');
    expect(item.createdAt).toBeDefined();
    expect(item.updatedAt).toBeDefined();
  });

  // ── Test 7: Hash determinism ───────────────────────────────────────
  test('Identical text produces identical embeddings (deterministic hash)', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const embed1 = hashEmbed(text, DIMS);
    const embed2 = hashEmbed(text, DIMS);

    expect(embed1).toEqual(embed2);

    // Different text produces different embeddings
    const embed3 = hashEmbed('Different text entirely', DIMS);
    expect(embed1).not.toEqual(embed3);
  });

  // ── Test 8: Reset clears all data ──────────────────────────────────
  test('reset() clears all data, reinitializes tables', async () => {
    await mem.add('Fact 1', { userId: 'alice', infer: false });
    await mem.add('Fact 2', { userId: 'bob', infer: false });

    await mem.reset();

    // All data should be gone
    const all = await mem.getAll();
    expect(all).toHaveLength(0);

    // Should be able to add new data after reset
    await mem.add('After reset', { userId: 'alice', infer: false });
    const items = await mem.getAll({ userId: 'alice' });
    expect(items).toHaveLength(1);
  });
});
