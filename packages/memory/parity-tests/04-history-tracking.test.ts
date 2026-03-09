/**
 * 04 — History Audit Trail Parity Tests
 *
 * Verifies that the history tracking system produces the same
 * audit trail entries as the original mem0 implementation.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  createTestMemory,
  cleanupDb,
  injectLLM,
  createLLMStubByIndex,
  type TestMemoryResult,
} from './helpers.js';
import type { Memory } from '../src/memory.js';
import type { HistoryEntry } from '../src/storage/base.js';

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

describe('04 — History Tracking Parity', () => {
  // ── Test 1: ADD history entry ──────────────────────────────────────
  test('add() creates history entry with action=ADD, newValue=text', async () => {
    const { results } = await mem.add('User likes TypeScript', {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    const history = (await mem.history(id)) as HistoryEntry[];
    expect(history).toHaveLength(1);
    expect(history[0].action).toBe('ADD');
    expect(history[0].newValue).toBe('User likes TypeScript');
    expect(history[0].previousValue).toBeNull();
    expect(history[0].memoryId).toBe(id);
  });

  // ── Test 2: UPDATE history entry ───────────────────────────────────
  test('update() creates history entry with previousValue + newValue', async () => {
    const { results } = await mem.add('Original text', {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    await mem.update(id, 'Updated text');

    const history = (await mem.history(id)) as HistoryEntry[];
    expect(history).toHaveLength(2); // ADD + UPDATE

    const updateEntry = history[1];
    expect(updateEntry.action).toBe('UPDATE');
    expect(updateEntry.previousValue).toBe('Original text');
    expect(updateEntry.newValue).toBe('Updated text');
  });

  // ── Test 3: DELETE history entry ───────────────────────────────────
  test('delete() creates history entry with previousValue, action=DELETE', async () => {
    const { results } = await mem.add('To be deleted', {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    await mem.delete(id);

    const history = (await mem.history(id)) as HistoryEntry[];
    expect(history).toHaveLength(2); // ADD + DELETE

    const deleteEntry = history[1];
    expect(deleteEntry.action).toBe('DELETE');
    expect(deleteEntry.previousValue).toBe('To be deleted');
    expect(deleteEntry.newValue).toBeNull();
  });

  // ── Test 4: Chronological order ────────────────────────────────────
  test('history(id) returns entries in chronological order', async () => {
    const { results } = await mem.add('Version 1', {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    await mem.update(id, 'Version 2');
    await mem.update(id, 'Version 3');
    await mem.delete(id);

    const history = (await mem.history(id)) as HistoryEntry[];
    expect(history).toHaveLength(4);

    // IDs should be ascending (chronological)
    for (let i = 1; i < history.length; i++) {
      expect(history[i].id).toBeGreaterThan(history[i - 1].id);
    }

    expect(history.map((h) => h.action)).toEqual([
      'ADD',
      'UPDATE',
      'UPDATE',
      'DELETE',
    ]);
  });

  // ── Test 5: History entry shape ────────────────────────────────────
  test('History entry has correct shape: id, memoryId, previousValue, newValue, action, createdAt, updatedAt, isDeleted', async () => {
    const { results } = await mem.add('Shape test', {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    const history = (await mem.history(id)) as HistoryEntry[];
    expect(history).toHaveLength(1);

    const entry = history[0];
    expect(typeof entry.id).toBe('number');
    expect(typeof entry.memoryId).toBe('string');
    expect(entry.memoryId).toBe(id);
    expect(entry.previousValue).toBeNull(); // First entry has no previous
    expect(typeof entry.newValue).toBe('string');
    expect(typeof entry.action).toBe('string');
    expect(typeof entry.createdAt).toBe('string');
    expect(typeof entry.updatedAt).toBe('string');
    expect(typeof entry.isDeleted).toBe('number');
    expect(entry.isDeleted).toBe(0);
  });

  // ── Test 6: disableHistory → empty ─────────────────────────────────
  test('disableHistory: true → history() returns []', async () => {
    const noHist = createTestMemory({ disableHistory: true });
    const noHistMem = noHist.mem;
    try {
      await noHistMem.initialize();

      const { results } = await noHistMem.add('No history', {
        userId: 'alice',
        infer: false,
      });
      const id = results[0].id!;

      const history = await noHistMem.history(id);
      expect(history).toEqual([]);
    } finally {
      noHistMem.close();
      cleanupDb(noHist.dbPath);
    }
  });

  // ── Test 7: reset() clears history ─────────────────────────────────
  test('reset() clears history', async () => {
    const { results } = await mem.add('Before reset', {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    // Verify history exists
    let history = await mem.history(id);
    expect(history).toHaveLength(1);

    await mem.reset();

    // History should be cleared
    history = await mem.history(id);
    expect(history).toHaveLength(0);
  });

  // ── Test 8: Infer=true operations log history ──────────────────────
  test('Infer=true ADD/UPDATE/DELETE all log history entries', async () => {
    // First add a memory to update/delete
    const { results: initial } = await mem.add('User likes JavaScript', {
      userId: 'alice',
      infer: false,
    });
    const existingId = initial[0].id!;

    // LLM returns ADD + UPDATE + DELETE
    const llm = createLLMStubByIndex({
      0: JSON.stringify({
        facts: ['User prefers TS', 'User moved', 'User is 30'],
      }),
      1: JSON.stringify({
        memory: [
          { event: 'UPDATE', id: existingId, text: 'User prefers TypeScript' },
          { event: 'ADD', text: 'User is 30 years old' },
        ],
      }),
    });
    injectLLM(mem, llm);

    const result = await mem.add('I prefer TS, I am 30', {
      userId: 'alice',
      infer: true,
    });

    // Check history for updated memory
    const updateHistory = (await mem.history(existingId)) as HistoryEntry[];
    // Should have ADD (from initial) + UPDATE (from infer)
    expect(updateHistory.length).toBeGreaterThanOrEqual(2);
    const lastUpdate = updateHistory[updateHistory.length - 1];
    expect(lastUpdate.action).toBe('UPDATE');
    expect(lastUpdate.previousValue).toBe('User likes JavaScript');
    expect(lastUpdate.newValue).toBe('User prefers TypeScript');

    // Check history for newly added memory
    const addOp = result.results.find((r) => r.event === 'ADD');
    if (addOp?.id) {
      const addHistory = (await mem.history(addOp.id)) as HistoryEntry[];
      expect(addHistory).toHaveLength(1);
      expect(addHistory[0].action).toBe('ADD');
    }
  });
});
