/**
 * Core Memory class — orchestrates LLM fact extraction, embedding,
 * vector storage, and history tracking.
 *
 * Ported from mem0-ts/src/oss/src/memory/index.ts with adaptations
 * for bun:sqlite + sqlite-vec.
 */
import type {
  MemoryConfig,
  MemoryItem,
  MemoryOperation,
  Message,
  SearchFilters,
} from './types.js';
import type { LLM } from './llms/base.js';
import type { Embedder } from './embeddings/base.js';
import type { VectorStore } from './vector-stores/base.js';
import type { HistoryManager } from './storage/base.js';
import { SqliteVecStore } from './vector-stores/sqlite-vec.js';

import { resolveConfig } from './config.js';
import { createLLM } from './llms/index.js';
import { createEmbedder } from './embeddings/index.js';
import { createVectorStore } from './vector-stores/index.js';
import { createHistoryManager } from './storage/index.js';
import { getFactRetrievalMessages, getUpdateMemoryMessages } from './prompts.js';
import { generateId, md5, safeJsonParse, parseMessages } from './utils/index.js';

export type AddOptions = {
  userId?: string;
  agentId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
  infer?: boolean;
};

export type SearchOptions = {
  userId?: string;
  agentId?: string;
  runId?: string;
  limit?: number;
};

export type GetAllOptions = {
  userId?: string;
  agentId?: string;
  runId?: string;
  limit?: number;
};

export class Memory {
  private llm: LLM;
  private embedder: Embedder;
  private vectorStore: VectorStore;
  private historyManager: HistoryManager | null;
  private customPrompt?: string;
  private initialized = false;

  constructor(config: MemoryConfig = {}) {
    const resolved = resolveConfig(config);

    this.llm = createLLM(resolved.llm);
    this.embedder = createEmbedder(resolved.embedder);
    this.vectorStore = createVectorStore(resolved.vectorStore);
    this.customPrompt = resolved.customPrompt;

    // History shares the vector store's DB when using sqlite-vec + no explicit path
    if (resolved.disableHistory) {
      this.historyManager = null;
    } else if (resolved.historyDbPath) {
      this.historyManager = createHistoryManager(resolved.historyDbPath);
    } else if (this.vectorStore instanceof SqliteVecStore) {
      // Share the same Database instance
      this.historyManager = createHistoryManager(this.vectorStore.getDb());
    } else {
      this.historyManager = null;
    }
  }

  /** Initialize the vector store (create tables, etc.). Call once before use. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.vectorStore.initialize();
    this.initialized = true;
  }

  /**
   * Add memories from messages. When `infer` is true (default), the LLM
   * extracts facts and decides which memories to add/update/delete.
   */
  async add(
    messages: string | Message[],
    opts: AddOptions = {},
  ): Promise<{ results: MemoryOperation[] }> {
    await this.initialize();

    const { userId, agentId, runId, metadata, infer = true } = opts;

    // Normalize input to message array
    const msgArray: Message[] =
      typeof messages === 'string'
        ? [{ role: 'user', content: messages }]
        : messages;

    if (!infer) {
      // Direct add without LLM inference — store the raw text as a single memory
      const text =
        typeof messages === 'string' ? messages : parseMessages(msgArray);
      const id = generateId();
      const embedding = await this.embedder.embed(text);
      const payload = buildPayload(text, userId, agentId, runId, metadata);
      await this.vectorStore.insert([embedding], [id], [payload]);
      await this.addHistoryEntry(id, null, text, 'ADD');
      return { results: [{ event: 'ADD', id, text }] };
    }

    // 1. Extract facts via LLM
    const parsedText = parseMessages(msgArray);
    const factMessages = getFactRetrievalMessages(parsedText, this.customPrompt);
    const factResponse = await this.llm.generateResponse(factMessages, {
      type: 'json_object',
    });
    const factText = typeof factResponse === 'string' ? factResponse : factResponse.content;
    const parsed = safeJsonParse<{ facts: string[] }>(factText);
    const facts = parsed?.facts ?? [];

    if (facts.length === 0) {
      return { results: [] };
    }

    // 2. Embed the extracted facts
    const factEmbeddings = await this.embedder.embedBatch(facts);

    // 3. For each fact, search for related existing memories
    const allExisting: MemoryItem[] = [];
    for (const embedding of factEmbeddings) {
      const results = await this.vectorStore.search(embedding, 5, {
        userId,
        agentId,
        runId,
      });
      for (const r of results) {
        if (!allExisting.some((e) => e.id === r.id)) {
          allExisting.push(vectorResultToMemoryItem(r));
        }
      }
    }

    // 4. Ask LLM to decide ADD/UPDATE/DELETE/NONE for each fact
    const updateMessages = getUpdateMemoryMessages(facts, allExisting);
    const updateResponse = await this.llm.generateResponse(updateMessages, {
      type: 'json_object',
    });
    const updateText =
      typeof updateResponse === 'string' ? updateResponse : updateResponse.content;
    const updateParsed = safeJsonParse<{ memory: MemoryOperation[] }>(updateText);
    const operations = updateParsed?.memory ?? [];

    // 5. Build a temp index map to resolve LLM-provided indexes to real IDs
    const indexToId = new Map<string, string>();
    allExisting.forEach((m, i) => indexToId.set(String(i), m.id));

    // 6. Execute operations
    const results: MemoryOperation[] = [];
    for (const op of operations) {
      try {
        switch (op.event) {
          case 'ADD': {
            if (!op.text) continue;
            const id = generateId();
            const embedding = await this.embedder.embed(op.text);
            const payload = buildPayload(op.text, userId, agentId, runId, metadata);
            await this.vectorStore.insert([embedding], [id], [payload]);
            await this.addHistoryEntry(id, null, op.text, 'ADD');
            results.push({ event: 'ADD', id, text: op.text });
            break;
          }
          case 'UPDATE': {
            const existingId = resolveId(op.id, indexToId);
            if (!existingId || !op.text) continue;
            const existing = await this.vectorStore.get(existingId);
            const prevText = (existing?.payload?.data as string) ?? '';
            const embedding = await this.embedder.embed(op.text);
            const payload = buildPayload(op.text, userId, agentId, runId, metadata);
            await this.vectorStore.update(existingId, embedding, payload);
            await this.addHistoryEntry(existingId, prevText, op.text, 'UPDATE');
            results.push({
              event: 'UPDATE',
              id: existingId,
              oldMemory: prevText,
              newMemory: op.text,
            });
            break;
          }
          case 'DELETE': {
            const existingId = resolveId(op.id, indexToId);
            if (!existingId) continue;
            const existing = await this.vectorStore.get(existingId);
            const prevText = (existing?.payload?.data as string) ?? '';
            await this.vectorStore.delete(existingId);
            await this.addHistoryEntry(existingId, prevText, null, 'DELETE');
            results.push({ event: 'DELETE', id: existingId });
            break;
          }
          case 'NONE':
          default:
            break;
        }
      } catch (err) {
        console.error(`Memory operation ${op.event} failed:`, err);
      }
    }

    return { results };
  }

  /** Search memories by semantic similarity. */
  async search(query: string, opts: SearchOptions = {}): Promise<MemoryItem[]> {
    await this.initialize();
    const { userId, agentId, runId, limit = 10 } = opts;

    const embedding = await this.embedder.embed(query);
    const results = await this.vectorStore.search(embedding, limit, {
      userId,
      agentId,
      runId,
    });

    return results.map(vectorResultToMemoryItem);
  }

  /** Get a single memory by ID. */
  async get(memoryId: string): Promise<MemoryItem | null> {
    await this.initialize();
    const result = await this.vectorStore.get(memoryId);
    if (!result) return null;
    return vectorResultToMemoryItem(result);
  }

  /** Get all memories matching the given filters. */
  async getAll(opts: GetAllOptions = {}): Promise<MemoryItem[]> {
    await this.initialize();
    const { userId, agentId, runId, limit = 100 } = opts;
    const [results] = await this.vectorStore.list(
      { userId, agentId, runId },
      limit,
    );
    return results.map(vectorResultToMemoryItem);
  }

  /** Update a memory's content (and re-embed). */
  async update(
    memoryId: string,
    data: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ id: string; content: string }> {
    await this.initialize();
    const existing = await this.vectorStore.get(memoryId);
    if (!existing) throw new Error(`Memory ${memoryId} not found`);

    const prevText = (existing.payload.data as string) ?? '';
    const embedding = await this.embedder.embed(data);
    const payload: Record<string, unknown> = {
      ...existing.payload,
      data,
      hash: md5(data),
      metadata: metadata ?? existing.payload.metadata,
    };
    await this.vectorStore.update(memoryId, embedding, payload);
    await this.addHistoryEntry(memoryId, prevText, data, 'UPDATE');

    return { id: memoryId, content: data };
  }

  /** Delete a single memory by ID. */
  async delete(memoryId: string): Promise<void> {
    await this.initialize();
    const existing = await this.vectorStore.get(memoryId);
    const prevText = (existing?.payload?.data as string) ?? '';
    await this.vectorStore.delete(memoryId);
    await this.addHistoryEntry(memoryId, prevText, null, 'DELETE');
  }

  /** Delete all memories matching the given user_id (or all if no filter). */
  async deleteAll(opts: { userId?: string } = {}): Promise<void> {
    await this.initialize();
    if (opts.userId) {
      const batchSize = 1000;
      let deleted: number;
      do {
        const [results] = await this.vectorStore.list(
          { userId: opts.userId },
          batchSize,
        );
        deleted = results.length;
        for (const r of results) {
          await this.vectorStore.delete(r.id);
          await this.addHistoryEntry(r.id, (r.payload.data as string) ?? '', null, 'DELETE');
        }
      } while (deleted >= batchSize);
    } else {
      await this.vectorStore.deleteCol();
      await this.historyManager?.reset();
    }
  }

  /** Get the mutation history for a specific memory. */
  async history(memoryId: string): Promise<unknown[]> {
    return (await this.historyManager?.getHistory(memoryId)) ?? [];
  }

  /** Reset everything — drop all data and reinitialize. */
  async reset(): Promise<void> {
    await this.vectorStore.deleteCol();
    await this.historyManager?.reset();
  }

  /** Close all database connections. */
  close(): void {
    this.vectorStore.close();
    this.historyManager?.close();
  }

  // ── Private helpers ───────────────────────────────────────────────

  private async addHistoryEntry(
    memoryId: string,
    prevValue: string | null,
    newValue: string | null,
    action: string,
  ): Promise<void> {
    try {
      await this.historyManager?.addHistory(memoryId, prevValue, newValue, action);
    } catch (err) {
      console.error('Failed to log history:', err);
    }
  }
}

// ── Module-level helpers ────────────────────────────────────────────

function buildPayload(
  text: string,
  userId?: string,
  agentId?: string,
  runId?: string,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    data: text,
    hash: md5(text),
    user_id: userId ?? null,
    agent_id: agentId ?? null,
    run_id: runId ?? null,
    metadata: metadata ?? {},
  };
}

function vectorResultToMemoryItem(r: { id: string; payload: Record<string, unknown>; score: number }): MemoryItem {
  return {
    id: r.id,
    content: (r.payload.data as string) ?? '',
    hash: (r.payload.hash as string) ?? undefined,
    metadata: (r.payload.metadata as Record<string, unknown>) ?? {},
    createdAt: (r.payload.created_at as string) ?? undefined,
    updatedAt: (r.payload.updated_at as string) ?? undefined,
    score: r.score,
  };
}

function resolveId(
  idOrIndex: string | number | undefined,
  indexMap: Map<string, string>,
): string | undefined {
  if (idOrIndex === undefined || idOrIndex === null) return undefined;
  // Coerce to string — LLM may return numeric JSON indices (0, 1, ...)
  // which JSON.parse produces as numbers, not strings.
  const key = String(idOrIndex);
  // If the LLM returned a numeric index, resolve it to the real UUID
  if (indexMap.has(key)) return indexMap.get(key);
  // Otherwise treat it as a direct ID
  return key;
}
