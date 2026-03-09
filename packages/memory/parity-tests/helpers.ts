/**
 * Shared test infrastructure for mem0 parity tests.
 *
 * Provides stub factories for LLM and Embedder so tests run without
 * external API calls, plus helpers for creating Memory instances,
 * managing temp databases, and spinning up test HTTP servers.
 */
import { Memory } from '../src/memory.js';
import type { LLM } from '../src/llms/base.js';
import type { Embedder } from '../src/embeddings/base.js';
import type { MemoryItem, Message } from '../src/types.js';
import { existsSync, unlinkSync } from 'node:fs';

// ── Constants ─────────────────────────────────────────────────────────

export const DIMS = 8;

// ── Stub Embedder ─────────────────────────────────────────────────────

/** Deterministic hash-based embedding: same text always produces same vector. */
export function hashEmbed(text: string, dims: number = DIMS): number[] {
  const vec = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % dims] += text.charCodeAt(i) / 1000;
  }
  const mag = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1;
  return vec.map((v: number) => v / mag);
}

/** Create a stub Embedder that uses deterministic hash-based vectors. */
export function stubEmbedder(dims: number = DIMS): Embedder {
  return {
    embed: async (text: string) => hashEmbed(text, dims),
    embedBatch: async (texts: string[]) => texts.map((t) => hashEmbed(t, dims)),
  };
}

// ── Stub LLM ──────────────────────────────────────────────────────────

export type LLMResponseFn = (
  callIndex: number,
  messages: Message[],
) => string;

/**
 * Create an LLM stub that delegates to a function receiving the call index
 * and message array. The function returns a raw string (typically JSON).
 */
export function createLLMStub(
  responseFn: LLMResponseFn,
): LLM & { callCount: number; lastMessages: Message[] } {
  let callCount = 0;
  let lastMessages: Message[] = [];
  return {
    get callCount() {
      return callCount;
    },
    get lastMessages() {
      return lastMessages;
    },
    generateResponse: async (messages: Message[]) => {
      lastMessages = messages;
      const response = responseFn(callCount, messages);
      callCount++;
      return response;
    },
  };
}

/** Create an LLM stub that returns pre-defined responses by call index. */
export function createLLMStubByIndex(
  responses: Record<number, string>,
): LLM & { callCount: number; lastMessages: Message[] } {
  return createLLMStub((index) => responses[index] ?? '{}');
}

// ── Database Helpers ──────────────────────────────────────────────────

let dbCounter = 0;

/** Generate a unique temp DB path for this test run. */
export function createTestDbPath(): string {
  return `/tmp/parity-test-${process.pid}-${Date.now()}-${dbCounter++}.db`;
}

/** Remove a test DB and its WAL/SHM files. */
export function cleanupDb(path: string): void {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ── Memory Factory ────────────────────────────────────────────────────

export type TestMemoryResult = {
  mem: Memory;
  dbPath: string;
};

/**
 * Create a Memory instance with stub embedder and a temp DB.
 * The LLM is initially a stub that creates a real OpenAI client — callers
 * that need infer=true should call `injectLLM()` to replace it.
 */
export function createTestMemory(
  opts: {
    dbPath?: string;
    dims?: number;
    disableHistory?: boolean;
    customPrompt?: string;
  } = {},
): TestMemoryResult {
  const dbPath = opts.dbPath ?? createTestDbPath();
  const dims = opts.dims ?? DIMS;

  const mem = new Memory({
    vectorStore: {
      provider: 'sqlite-vec',
      config: { dbPath, collectionName: 'test', dimensions: dims },
    },
    embedder: {
      provider: 'openai',
      config: { model: 'stub', apiKey: 'stub', dimensions: dims },
    },
    llm: {
      provider: 'openai',
      config: { model: 'stub', apiKey: 'stub' },
    },
    disableHistory: opts.disableHistory ?? false,
    customPrompt: opts.customPrompt,
  });

  // Inject stub embedder (replaces the real OpenAI one)
  (mem as any).embedder = stubEmbedder(dims);

  return { mem, dbPath };
}

/** Inject a stub LLM into a Memory instance. */
export function injectLLM(mem: Memory, llm: LLM): void {
  (mem as any).llm = llm;
}

// ── Memory Item Assertions ────────────────────────────────────────────

/** Assert that a MemoryItem has the expected shape and values. */
export function assertMemoryShape(item: MemoryItem): void {
  if (typeof item.id !== 'string' || item.id.length === 0) {
    throw new Error(`Expected non-empty string id, got: ${item.id}`);
  }
  if (typeof item.content !== 'string') {
    throw new Error(`Expected string content, got: ${typeof item.content}`);
  }
  if (typeof item.metadata !== 'object' || item.metadata === null) {
    throw new Error(`Expected object metadata, got: ${typeof item.metadata}`);
  }
}

// ── Test Server ───────────────────────────────────────────────────────

/**
 * Create a lightweight HTTP server that mirrors core/memory/src/server.ts
 * routes but uses a provided Memory instance (with stubs).
 */
export function createTestServer(memory: Memory): {
  url: string;
  port: number;
  close: () => void;
} {
  function normalizeMemory(item: {
    id: string;
    content: string;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }) {
    return {
      id: item.id,
      content: item.content,
      metadata: item.metadata ?? {},
      created_at: item.createdAt ?? '',
    };
  }

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function errorResponse(status: number, detail: string): Response {
    return json({ detail }, status);
  }

  async function readBody(req: Request): Promise<Record<string, unknown>> {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  const server = Bun.serve({
    port: 0,
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      try {
        // Health
        if (path === '/health' && method === 'GET') {
          return json({ status: 'ok' });
        }

        // POST /api/v1/memories/
        if (path === '/api/v1/memories/' && method === 'POST') {
          const body = await readBody(req);
          if (!body.text || typeof body.text !== 'string' || (body.text as string).trim() === '') {
            return errorResponse(400, 'text is required and must be a non-empty string');
          }
          const result = await memory.add(body.text as string, {
            userId: (body.user_id as string) ?? 'default_user',
            agentId: body.agent_id as string,
            runId: body.run_id as string,
            metadata: body.metadata as Record<string, unknown>,
            infer: body.infer !== false,
          });
          const firstId =
            (result.results as { id?: string }[])?.find((r) => r.id)?.id ?? null;
          return json({ ...result, id: firstId });
        }

        // POST /api/v1/memories/filter
        if (path === '/api/v1/memories/filter' && method === 'POST') {
          const body = await readBody(req);

          if (body.search_query) {
            const results = await memory.search(body.search_query as string, {
              userId: (body.user_id as string) ?? 'default_user',
              agentId: body.agent_id as string,
              runId: body.run_id as string,
              limit: (body.size as number) ?? 10,
            });
            return json({ items: results.map(normalizeMemory) });
          }

          const results = await memory.getAll({
            userId: (body.user_id as string) ?? 'default_user',
            agentId: body.agent_id as string,
            runId: body.run_id as string,
            limit: (body.size as number) ?? 10,
          });
          return json({ items: results.map(normalizeMemory) });
        }

        // POST /api/v2/memories/search
        if (path === '/api/v2/memories/search' && method === 'POST') {
          const body = await readBody(req);
          const query = (body.query ?? body.search_query) as string;
          if (!query) return errorResponse(400, 'query is required');

          const results = await memory.search(query, {
            userId: (body.user_id as string) ?? 'default_user',
            agentId: body.agent_id as string,
            runId: body.run_id as string,
            limit: (body.size as number) ?? 10,
          });
          return json({ results: results.map(normalizeMemory) });
        }

        // GET/PUT /api/v1/memories/:id
        const memoryMatch = path.match(/^\/api\/v1\/memories\/([^/]+)$/);

        if (memoryMatch && method === 'GET') {
          const memoryId = decodeURIComponent(memoryMatch[1]);
          const result = await memory.get(memoryId);
          if (!result) return errorResponse(404, 'Memory not found');
          return json(normalizeMemory(result));
        }

        if (memoryMatch && method === 'PUT') {
          const memoryId = decodeURIComponent(memoryMatch[1]);
          const body = await readBody(req);
          if (!body.data || typeof body.data !== 'string' || (body.data as string).trim() === '') {
            return errorResponse(400, 'data is required and must be a non-empty string');
          }
          const result = await memory.update(memoryId, body.data as string);
          return json(result);
        }

        // DELETE /api/v1/memories/
        if (path === '/api/v1/memories/' && method === 'DELETE') {
          const body = await readBody(req);
          if (body.memory_id) {
            await memory.delete(body.memory_id as string);
            return json({ status: 'ok', deleted: body.memory_id });
          }
          if (body.user_id) {
            await memory.deleteAll({ userId: body.user_id as string });
            return json({ status: 'ok', deleted_all_for: body.user_id });
          }
          return errorResponse(400, 'memory_id or user_id required');
        }

        // GET /api/v1/stats/
        if (path === '/api/v1/stats/' && method === 'GET') {
          const userId = url.searchParams.get('user_id') ?? 'default_user';
          const limit = 10000;
          const items = await memory.getAll({ userId, limit });
          const count = items.length;
          return json({
            total_memories: count,
            total_apps: 1,
            approximate: true,
            max_sampled: limit,
            capped: count >= limit,
          });
        }

        return errorResponse(404, 'Not found');
      } catch (err) {
        console.error('Test server error:', err);
        return errorResponse(500, 'Internal server error');
      }
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    port: server.port,
    close: () => server.stop(),
  };
}
