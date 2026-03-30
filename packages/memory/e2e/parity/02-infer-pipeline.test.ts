/**
 * 02 — LLM Inference Pipeline Parity Tests
 *
 * Verifies the 2-phase LLM pipeline (fact extraction + memory update)
 * matches mem0's behavior. All LLM calls are stubbed.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  createTestMemory,
  cleanupDb,
  injectLLM,
  createLLMStub,
  createLLMStubByIndex,
  type TestMemoryResult,
} from './helpers.js';
import type { Memory } from '../../src/memory.js';
import type { Message } from '../../src/types.js';
import { getFactRetrievalMessages, getUpdateMemoryMessages } from '../../src/prompts.js';

let t: TestMemoryResult;
let mem: Memory;

beforeEach(async () => {
  t = createTestMemory();
  mem = t.mem;
});

afterEach(() => {
  mem.close();
  cleanupDb(t.dbPath);
});

describe('02 — Infer Pipeline Parity', () => {
  // ── Test 1: Fact extraction prompt structure ───────────────────────
  test('Phase 1: fact extraction prompt is [system, user] with input text', () => {
    const messages = getFactRetrievalMessages('user: Hello world');

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('user: Hello world');
    expect(messages[1].content).toContain('Return a valid JSON object');
    expect(messages[1].content).toContain('"facts"');
  });

  // ── Test 2: Custom prompt overrides default ────────────────────────
  test('Phase 1: custom prompt overrides default extraction prompt', () => {
    const custom = 'You are a custom extractor. Extract key preferences.';
    const messages = getFactRetrievalMessages('user: I like blue', custom);

    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe(custom);
  });

  // ── Test 3: Empty facts → empty results ────────────────────────────
  test('Phase 1: empty facts array → empty results', async () => {
    const llm = createLLMStubByIndex({
      0: JSON.stringify({ facts: [] }),
    });
    injectLLM(mem, llm);
    await mem.initialize();

    const result = await mem.add('Just chatting, no facts', {
      userId: 'alice',
      infer: true,
    });

    expect(result.results).toHaveLength(0);
    expect(llm.callCount).toBe(1); // Only fact extraction, no update call
  });

  // ── Test 4: Multi-fact extraction ──────────────────────────────────
  test('Phase 1: multi-fact extraction triggers Phase 2', async () => {
    const llm = createLLMStubByIndex({
      0: JSON.stringify({
        facts: ['User likes TypeScript', 'User works at Acme'],
      }),
      1: JSON.stringify({
        memory: [
          { event: 'ADD', text: 'User likes TypeScript' },
          { event: 'ADD', text: 'User works at Acme' },
        ],
      }),
    });
    injectLLM(mem, llm);
    await mem.initialize();

    const result = await mem.add('I like TypeScript and work at Acme', {
      userId: 'alice',
      infer: true,
    });

    expect(llm.callCount).toBe(2); // Phase 1 + Phase 2
    expect(result.results).toHaveLength(2);
    expect(result.results.map((r) => r.event)).toEqual(['ADD', 'ADD']);
  });

  // ── Test 5: Existing memories formatted as "[idx] id={id}: {content}" ─
  test('Phase 2: existing memories formatted as [idx] id={id}: {content}', () => {
    const existing = [
      { id: 'mem-1', content: 'User likes cats', metadata: {}, score: 0.9 },
      { id: 'mem-2', content: 'User lives in NYC', metadata: {}, score: 0.8 },
    ];
    const facts = ['User likes dogs'];
    const messages = getUpdateMemoryMessages(facts, existing);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('[0] id=mem-1: User likes cats');
    expect(messages[1].content).toContain('[1] id=mem-2: User lives in NYC');
    expect(messages[1].content).toContain('[0] User likes dogs');
  });

  // ── Test 6: ADD operation creates new memory ───────────────────────
  test('Phase 2: ADD operation creates new memory with embedding', async () => {
    const llm = createLLMStubByIndex({
      0: JSON.stringify({ facts: ['User prefers dark mode'] }),
      1: JSON.stringify({
        memory: [{ event: 'ADD', text: 'User prefers dark mode' }],
      }),
    });
    injectLLM(mem, llm);
    await mem.initialize();

    const result = await mem.add('I always use dark mode', {
      userId: 'alice',
      infer: true,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].event).toBe('ADD');
    expect(result.results[0].text).toBe('User prefers dark mode');
    expect(result.results[0].id).toBeDefined();

    // Verify it was actually stored
    const item = await mem.get(result.results[0].id!);
    expect(item).not.toBeNull();
    expect(item!.content).toBe('User prefers dark mode');
  });

  // ── Test 7: UPDATE with numeric index resolves to existing memory ──
  test('Phase 2: UPDATE with numeric ID resolves to existing memory', async () => {
    // Pre-populate a memory
    const { results: added } = await mem.add('User likes JavaScript', {
      userId: 'alice',
      infer: false,
    });
    const existingId = added[0].id!;

    // LLM returns UPDATE with index "0" (referring to the first existing memory)
    const llm = createLLMStubByIndex({
      0: JSON.stringify({ facts: ['User likes TypeScript more'] }),
      1: JSON.stringify({
        memory: [
          { event: 'UPDATE', id: '0', text: 'User likes TypeScript more than JavaScript' },
        ],
      }),
    });
    injectLLM(mem, llm);

    const result = await mem.add('Actually I prefer TypeScript', {
      userId: 'alice',
      infer: true,
    });

    const updateOp = result.results.find((r) => r.event === 'UPDATE');
    expect(updateOp).toBeDefined();
    expect(updateOp!.id).toBe(existingId);
    expect(updateOp!.newMemory).toBe('User likes TypeScript more than JavaScript');

    const item = await mem.get(existingId);
    expect(item!.content).toBe('User likes TypeScript more than JavaScript');
  });

  // ── Test 8: UPDATE with UUID resolves directly ─────────────────────
  test('Phase 2: UPDATE with UUID resolves directly', async () => {
    const { results: added } = await mem.add('User likes cats', {
      userId: 'alice',
      infer: false,
    });
    const existingId = added[0].id!;

    const llm = createLLMStubByIndex({
      0: JSON.stringify({ facts: ['User loves cats and dogs'] }),
      1: JSON.stringify({
        memory: [
          { event: 'UPDATE', id: existingId, text: 'User loves cats and dogs' },
        ],
      }),
    });
    injectLLM(mem, llm);

    const result = await mem.add('I also love dogs', {
      userId: 'alice',
      infer: true,
    });

    const updateOp = result.results.find((r) => r.event === 'UPDATE');
    expect(updateOp).toBeDefined();
    expect(updateOp!.id).toBe(existingId);
  });

  // ── Test 9: DELETE removes existing memory ─────────────────────────
  test('Phase 2: DELETE removes existing memory', async () => {
    const { results: added } = await mem.add('User lives in NYC', {
      userId: 'alice',
      infer: false,
    });
    const existingId = added[0].id!;

    const llm = createLLMStubByIndex({
      0: JSON.stringify({ facts: ['User moved to London'] }),
      1: JSON.stringify({
        memory: [
          { event: 'DELETE', id: existingId },
          { event: 'ADD', text: 'User lives in London' },
        ],
      }),
    });
    injectLLM(mem, llm);

    const result = await mem.add('I just moved to London', {
      userId: 'alice',
      infer: true,
    });

    const deleteOp = result.results.find((r) => r.event === 'DELETE');
    expect(deleteOp).toBeDefined();
    expect(deleteOp!.id).toBe(existingId);

    const deleted = await mem.get(existingId);
    expect(deleted).toBeNull();
  });

  // ── Test 10: NONE produces no operation ────────────────────────────
  test('Phase 2: NONE produces no operation', async () => {
    const llm = createLLMStubByIndex({
      0: JSON.stringify({ facts: ['Something already known'] }),
      1: JSON.stringify({
        memory: [{ event: 'NONE' }],
      }),
    });
    injectLLM(mem, llm);
    await mem.initialize();

    const result = await mem.add('Repeat info', {
      userId: 'alice',
      infer: true,
    });

    expect(result.results).toHaveLength(0);
  });

  // ── Test 11: Mixed operations in single response ───────────────────
  test('Mixed operations (ADD + UPDATE + DELETE) in single response', async () => {
    // Pre-populate two memories
    const { results: r1 } = await mem.add('User likes JavaScript', {
      userId: 'alice',
      infer: false,
    });
    const { results: r2 } = await mem.add('User lives in NYC', {
      userId: 'alice',
      infer: false,
    });
    const jsId = r1[0].id!;
    const nycId = r2[0].id!;

    const llm = createLLMStubByIndex({
      0: JSON.stringify({
        facts: ['User prefers TypeScript', 'User moved to London', 'User age is 30'],
      }),
      1: JSON.stringify({
        memory: [
          { event: 'UPDATE', id: jsId, text: 'User prefers TypeScript over JavaScript' },
          { event: 'DELETE', id: nycId },
          { event: 'ADD', text: 'User is 30 years old' },
        ],
      }),
    });
    injectLLM(mem, llm);

    const result = await mem.add(
      'I prefer TypeScript, moved to London, and I am 30',
      { userId: 'alice', infer: true },
    );

    const events = result.results.map((r) => r.event);
    expect(events).toContain('UPDATE');
    expect(events).toContain('DELETE');
    expect(events).toContain('ADD');

    // Verify mutations applied
    const updated = await mem.get(jsId);
    expect(updated!.content).toBe('User prefers TypeScript over JavaScript');

    const deleted = await mem.get(nycId);
    expect(deleted).toBeNull();

    const all = await mem.getAll({ userId: 'alice' });
    expect(all).toHaveLength(2); // updated JS + new age
  });

  // ── Test 12: Individual operation failure doesn't abort entire add()
  test('Individual operation failure does not abort entire add()', async () => {
    const llm = createLLMStubByIndex({
      0: JSON.stringify({ facts: ['Fact A', 'Fact B'] }),
      1: JSON.stringify({
        memory: [
          { event: 'ADD', text: 'Fact A' },
          { event: 'UPDATE', id: 'nonexistent-memory-id', text: 'Fact B' },
        ],
      }),
    });
    injectLLM(mem, llm);
    await mem.initialize();

    // Should not throw
    const result = await mem.add('Multiple facts', {
      userId: 'alice',
      infer: true,
    });

    // ADD succeeds, UPDATE on nonexistent is skipped (not thrown)
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0].event).toBe('ADD');
  });
});
