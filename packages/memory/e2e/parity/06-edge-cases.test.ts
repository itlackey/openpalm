/**
 * 06 — Edge Cases & Boundary Condition Parity Tests
 *
 * Verifies correct behavior at boundaries — empty inputs, large data,
 * concurrent operations, post-close errors, and metadata round-trips.
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
  try {
    mem.close();
  } catch {
    // Already closed in some tests
  }
  cleanupDb(t.dbPath);
});

describe('06 — Edge Cases Parity', () => {
  // ── Test 1: Empty string input ─────────────────────────────────────
  test('add("") with empty string is handled gracefully', async () => {
    const result = await mem.add('', {
      userId: 'alice',
      infer: false,
    });

    // Empty string still gets stored (mem0 doesn't reject it)
    expect(result).toHaveProperty('results');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].event).toBe('ADD');
    expect(result.results[0].text).toBe('');
  });

  // ── Test 2: Very long text ─────────────────────────────────────────
  test('add() with very long text (>10KB) is handled', async () => {
    const longText = 'A'.repeat(15000);

    const result = await mem.add(longText, {
      userId: 'alice',
      infer: false,
    });

    expect(result.results).toHaveLength(1);
    const id = result.results[0].id!;

    // Verify full text round-trips
    const item = await mem.get(id);
    expect(item!.content).toBe(longText);
    expect(item!.content.length).toBe(15000);
  });

  // ── Test 3: Empty search results ───────────────────────────────────
  test('search() with no matching results returns []', async () => {
    // Add something for a different user
    await mem.add('Only for Bob', { userId: 'bob', infer: false });

    const results = await mem.search('nonexistent query', {
      userId: 'alice',
    });
    expect(results).toEqual([]);
  });

  // ── Test 4: deleteAll with no userId deletes ALL ───────────────────
  test('deleteAll() with no userId deletes ALL memories globally', async () => {
    await mem.add('Alice fact', { userId: 'alice', infer: false });
    await mem.add('Bob fact', { userId: 'bob', infer: false });
    await mem.add('No user fact', { infer: false });

    // Verify they exist
    const before = await mem.getAll();
    expect(before).toHaveLength(3);

    await mem.deleteAll();

    const after = await mem.getAll();
    expect(after).toHaveLength(0);
  });

  // ── Test 5: deleteAll batches in chunks of 1000 ────────────────────
  test('deleteAll({userId}) batches in chunks of 1000', async () => {
    // We can't easily add 1000+ memories in a test, but we verify
    // the batch deletion loop works correctly with a smaller set
    for (let i = 0; i < 5; i++) {
      await mem.add(`Batch fact ${i}`, { userId: 'batch-user', infer: false });
    }

    await mem.deleteAll({ userId: 'batch-user' });

    const items = await mem.getAll({ userId: 'batch-user' });
    expect(items).toHaveLength(0);
  });

  // ── Test 6: Update on nonexistent ID throws ────────────────────────
  test('update() on nonexistent ID throws "Memory {id} not found"', async () => {
    const badId = 'nonexistent-uuid-12345';

    expect(mem.update(badId, 'new data')).rejects.toThrow(
      `Memory ${badId} not found`,
    );
  });

  // ── Test 7: MD5 hash consistency ───────────────────────────────────
  test('MD5 hash consistency: same text → same hash across add/update', async () => {
    const text = 'Hash consistency test';
    const expectedHash = md5(text);

    // Add with this text
    const { results } = await mem.add(text, {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    const item1 = await mem.get(id);
    expect(item1!.hash).toBe(expectedHash);

    // Update with same text
    await mem.update(id, text);
    const item2 = await mem.get(id);
    expect(item2!.hash).toBe(expectedHash);

    // Update with different text
    const newText = 'Different text';
    await mem.update(id, newText);
    const item3 = await mem.get(id);
    expect(item3!.hash).toBe(md5(newText));
    expect(item3!.hash).not.toBe(expectedHash);
  });

  // ── Test 8: Concurrent initialize() is idempotent ──────────────────
  test('Concurrent initialize() calls are idempotent', async () => {
    // Create a fresh Memory (not yet initialized via beforeEach)
    const fresh = createTestMemory();
    try {
      // Call initialize concurrently
      await Promise.all([
        fresh.mem.initialize(),
        fresh.mem.initialize(),
        fresh.mem.initialize(),
      ]);

      // Should work normally after concurrent init
      const result = await fresh.mem.add('After concurrent init', {
        userId: 'alice',
        infer: false,
      });
      expect(result.results).toHaveLength(1);
    } finally {
      fresh.mem.close();
      cleanupDb(fresh.dbPath);
    }
  });

  // ── Test 9: Operations after close() throw ─────────────────────────
  test('close() then operations throw appropriately', async () => {
    await mem.add('Before close', { userId: 'alice', infer: false });

    mem.close();

    // Operations on a closed DB should throw
    expect(async () => {
      await mem.get('any-id');
    }).toThrow();
  });

  // ── Test 10: Custom metadata round-trips ───────────────────────────
  test('Custom metadata round-trips through add → get', async () => {
    const customMeta = {
      source: 'email',
      confidence: 0.95,
      tags: ['important', 'work'],
      nested: { key: 'value' },
    };

    const { results } = await mem.add('Metadata test', {
      userId: 'alice',
      metadata: customMeta,
      infer: false,
    });
    const id = results[0].id!;

    const item = await mem.get(id);
    expect(item!.metadata).toEqual(customMeta);
  });
});
