/**
 * Tests for the Memory class — core orchestrator.
 * Uses stub LLM and embedder implementations to test the full pipeline
 * without external API calls.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Memory } from '../memory.js';
import { unlinkSync, existsSync } from 'node:fs';

const TEST_DB = '/tmp/test-memory-class.db';
const DIMS = 4;

function cleanup() {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

// Stub embedder: returns a simple hash-based vector of fixed dimensions
function stubEmbedVector(text: string): number[] {
  const vec = new Array(DIMS).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % DIMS] += text.charCodeAt(i) / 1000;
  }
  // Normalize
  const mag = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1;
  return vec.map((v: number) => v / mag);
}

// Mock modules: replace LLM and Embedder factories with stubs
// We use the Memory constructor with custom config that maps to these stubs.
// Since Memory uses factory functions internally, we need to test through the
// lower-level APIs and also test the Memory class with direct injection.

describe('Memory class (infer=false, no LLM needed)', () => {
  let mem: Memory;

  beforeEach(async () => {
    cleanup();
    mem = new Memory({
      vectorStore: {
        provider: 'sqlite-vec',
        config: { dbPath: TEST_DB, collectionName: 'test', dimensions: DIMS },
      },
      embedder: {
        provider: 'openai',
        config: { model: 'stub', apiKey: 'stub', dimensions: DIMS },
      },
      llm: {
        provider: 'openai',
        config: { model: 'stub', apiKey: 'stub' },
      },
      disableHistory: false,
    });
  });

  afterEach(() => {
    mem.close();
    cleanup();
  });

  test('add with infer=false stores raw text', async () => {
    // Mock the embedder.embed method
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await mem.initialize();

    const result = await mem.add('User likes TypeScript', {
      userId: 'alice',
      infer: false,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].event).toBe('ADD');
    expect(result.results[0].text).toBe('User likes TypeScript');
    expect(result.results[0].id).toBeDefined();
  });

  test('add with infer=false from message array', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await mem.initialize();

    const result = await mem.add(
      [{ role: 'user' as const, content: 'Hello world' }],
      { userId: 'bob', infer: false },
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].event).toBe('ADD');
  });

  test('search returns matching memories', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await mem.initialize();

    await mem.add('User likes TypeScript', { userId: 'alice', infer: false });
    await mem.add('User prefers dark mode', { userId: 'alice', infer: false });

    const results = await mem.search('TypeScript', { userId: 'alice' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toBeDefined();
  });

  test('get returns a specific memory', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await mem.initialize();

    const { results } = await mem.add('Fact to retrieve', {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    const item = await mem.get(id);
    expect(item).not.toBeNull();
    expect(item!.id).toBe(id);
    expect(item!.content).toBe('Fact to retrieve');
  });

  test('get returns null for nonexistent ID', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await mem.initialize();

    const item = await mem.get('nonexistent-id');
    expect(item).toBeNull();
  });

  test('getAll returns all memories for a user', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await mem.initialize();

    await mem.add('Fact 1', { userId: 'alice', infer: false });
    await mem.add('Fact 2', { userId: 'alice', infer: false });
    await mem.add('Fact 3', { userId: 'bob', infer: false });

    const aliceItems = await mem.getAll({ userId: 'alice' });
    expect(aliceItems).toHaveLength(2);

    const bobItems = await mem.getAll({ userId: 'bob' });
    expect(bobItems).toHaveLength(1);
  });

  test('update changes content and re-embeds', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await mem.initialize();

    const { results } = await mem.add('Original fact', {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    const updated = await mem.update(id, 'Updated fact');
    expect(updated.id).toBe(id);
    expect(updated.content).toBe('Updated fact');

    const item = await mem.get(id);
    expect(item!.content).toBe('Updated fact');
  });

  test('update with metadata preserves metadata', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await mem.initialize();

    const { results } = await mem.add('Fact', {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    await mem.update(id, 'Updated fact', { custom: 'meta' });
    const item = await mem.get(id);
    expect(item!.metadata).toEqual({ custom: 'meta' });
  });

  test('update throws for nonexistent memory', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await mem.initialize();

    expect(mem.update('nonexistent', 'data')).rejects.toThrow(
      'Memory nonexistent not found',
    );
  });

  test('delete removes a memory', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await mem.initialize();

    const { results } = await mem.add('To delete', {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    await mem.delete(id);
    const item = await mem.get(id);
    expect(item).toBeNull();
  });

  test('deleteAll removes all memories for a user', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await mem.initialize();

    await mem.add('Fact 1', { userId: 'alice', infer: false });
    await mem.add('Fact 2', { userId: 'alice', infer: false });
    await mem.add('Fact 3', { userId: 'bob', infer: false });

    await mem.deleteAll({ userId: 'alice' });

    const alice = await mem.getAll({ userId: 'alice' });
    expect(alice).toHaveLength(0);

    const bob = await mem.getAll({ userId: 'bob' });
    expect(bob).toHaveLength(1);
  });

  test('history tracks mutations', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await mem.initialize();

    const { results } = await mem.add('Original', {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    await mem.update(id, 'Updated');
    await mem.delete(id);

    const history = await mem.history(id);
    expect(history).toHaveLength(3);
    expect((history[0] as any).action).toBe('ADD');
    expect((history[1] as any).action).toBe('UPDATE');
    expect((history[2] as any).action).toBe('DELETE');
  });

  test('reset clears all data', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await mem.initialize();

    await mem.add('Fact 1', { userId: 'alice', infer: false });
    await mem.add('Fact 2', { userId: 'bob', infer: false });

    await mem.reset();

    const all = await mem.getAll();
    expect(all).toHaveLength(0);
  });

  test('initialize is idempotent', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };

    await mem.initialize();
    await mem.initialize(); // Should not throw
  });

  test('history returns empty when history is disabled', async () => {
    cleanup();
    const noHistMem = new Memory({
      vectorStore: {
        provider: 'sqlite-vec',
        config: { dbPath: TEST_DB, collectionName: 'test', dimensions: DIMS },
      },
      embedder: {
        provider: 'openai',
        config: { model: 'stub', apiKey: 'stub', dimensions: DIMS },
      },
      llm: {
        provider: 'openai',
        config: { model: 'stub', apiKey: 'stub' },
      },
      disableHistory: true,
    });
    (noHistMem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await noHistMem.initialize();

    const { results } = await noHistMem.add('Fact', {
      userId: 'alice',
      infer: false,
    });
    const id = results[0].id!;

    const history = await noHistMem.history(id);
    expect(history).toEqual([]);
    noHistMem.close();
  });
});

describe('Memory class (infer=true, with stub LLM)', () => {
  let mem: Memory;

  beforeEach(async () => {
    cleanup();
    mem = new Memory({
      vectorStore: {
        provider: 'sqlite-vec',
        config: { dbPath: TEST_DB, collectionName: 'test', dimensions: DIMS },
      },
      embedder: {
        provider: 'openai',
        config: { model: 'stub', apiKey: 'stub', dimensions: DIMS },
      },
      llm: {
        provider: 'openai',
        config: { model: 'stub', apiKey: 'stub' },
      },
      disableHistory: false,
    });
  });

  afterEach(() => {
    mem.close();
    cleanup();
  });

  test('add with infer=true extracts facts via LLM', async () => {
    let llmCallCount = 0;
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    (mem as any).llm = {
      generateResponse: async () => {
        llmCallCount++;
        if (llmCallCount === 1) {
          // Fact extraction response
          return JSON.stringify({ facts: ['User likes TypeScript'] });
        }
        // Update memory response
        return JSON.stringify({
          memory: [{ event: 'ADD', text: 'User likes TypeScript' }],
        });
      },
    };
    await mem.initialize();

    const result = await mem.add('I really enjoy using TypeScript', {
      userId: 'alice',
      infer: true,
    });

    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0].event).toBe('ADD');
    expect(llmCallCount).toBe(2);
  });

  test('add with infer=true returns empty when no facts extracted', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    (mem as any).llm = {
      generateResponse: async () => {
        return JSON.stringify({ facts: [] });
      },
    };
    await mem.initialize();

    const result = await mem.add('Just chatting', {
      userId: 'alice',
      infer: true,
    });

    expect(result.results).toHaveLength(0);
  });

  test('add with infer=true handles UPDATE operation', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await mem.initialize();

    // First add a memory directly
    const { results: added } = await mem.add('User likes JavaScript', {
      userId: 'alice',
      infer: false,
    });
    const existingId = added[0].id!;

    // Now set up LLM to return UPDATE operation using the existing ID
    let llmCallCount = 0;
    (mem as any).llm = {
      generateResponse: async () => {
        llmCallCount++;
        if (llmCallCount === 1) {
          return JSON.stringify({ facts: ['User likes TypeScript more than JavaScript'] });
        }
        return JSON.stringify({
          memory: [{
            event: 'UPDATE',
            id: existingId,
            text: 'User likes TypeScript more than JavaScript',
          }],
        });
      },
    };

    const result = await mem.add('Actually I prefer TypeScript over JavaScript', {
      userId: 'alice',
      infer: true,
    });

    const updateOp = result.results.find(r => r.event === 'UPDATE');
    expect(updateOp).toBeDefined();
    expect(updateOp!.id).toBe(existingId);

    const item = await mem.get(existingId);
    expect(item!.content).toBe('User likes TypeScript more than JavaScript');
  });

  test('add with infer=true handles DELETE operation', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    await mem.initialize();

    // First add a memory directly
    const { results: added } = await mem.add('User lives in NYC', {
      userId: 'alice',
      infer: false,
    });
    const existingId = added[0].id!;

    let llmCallCount = 0;
    (mem as any).llm = {
      generateResponse: async () => {
        llmCallCount++;
        if (llmCallCount === 1) {
          return JSON.stringify({ facts: ['User moved to London'] });
        }
        return JSON.stringify({
          memory: [
            { event: 'DELETE', id: existingId },
            { event: 'ADD', text: 'User lives in London' },
          ],
        });
      },
    };

    const result = await mem.add('I just moved to London', {
      userId: 'alice',
      infer: true,
    });

    const deleteOp = result.results.find(r => r.event === 'DELETE');
    expect(deleteOp).toBeDefined();

    const item = await mem.get(existingId);
    expect(item).toBeNull();
  });

  test('add with infer=true handles LLM returning NONE', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    let llmCallCount = 0;
    (mem as any).llm = {
      generateResponse: async () => {
        llmCallCount++;
        if (llmCallCount === 1) {
          return JSON.stringify({ facts: ['Something already known'] });
        }
        return JSON.stringify({
          memory: [{ event: 'NONE' }],
        });
      },
    };
    await mem.initialize();

    const result = await mem.add('Repeat info', {
      userId: 'alice',
      infer: true,
    });

    expect(result.results).toHaveLength(0);
  });

  test('add handles LLM failure gracefully per-operation', async () => {
    (mem as any).embedder = {
      embed: async (text: string) => stubEmbedVector(text),
      embedBatch: async (texts: string[]) => texts.map(stubEmbedVector),
    };
    let llmCallCount = 0;
    (mem as any).llm = {
      generateResponse: async () => {
        llmCallCount++;
        if (llmCallCount === 1) {
          return JSON.stringify({ facts: ['fact1', 'fact2'] });
        }
        return JSON.stringify({
          memory: [
            { event: 'ADD', text: 'fact1' },
            { event: 'UPDATE', id: 'nonexistent-id', text: 'fact2' },
          ],
        });
      },
    };
    await mem.initialize();

    // Should not throw — individual op failures are caught
    const result = await mem.add('Multiple facts', {
      userId: 'alice',
      infer: true,
    });

    // The ADD succeeds, the UPDATE on nonexistent ID is a no-op (skipped)
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });
});
