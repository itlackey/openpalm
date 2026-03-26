/**
 * Core type definitions for the @openpalm/memory package.
 * Ported from mem0-ts/src/oss/src/types with adaptations for sqlite-vec.
 */

// ── Messages ──────────────────────────────────────────────────────────

export type Message = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

// ── Configuration ─────────────────────────────────────────────────────

export type LLMProviderConfig = {
  provider: string;
  config: {
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
    [key: string]: unknown;
  };
};

export type EmbedderProviderConfig = {
  provider: string;
  config: {
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    dimensions?: number;
    [key: string]: unknown;
  };
};

export type VectorStoreProviderConfig = {
  provider: string;
  config: {
    dbPath?: string;
    collectionName?: string;
    dimensions?: number;
    [key: string]: unknown;
  };
};

export type RerankingConfig = {
  enabled: boolean;
  provider?: string;
  mode?: 'llm' | 'dedicated';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  topK?: number;
  topN?: number;
};

export type MemoryConfig = {
  llm?: LLMProviderConfig;
  embedder?: EmbedderProviderConfig;
  vectorStore?: VectorStoreProviderConfig;
  reranking?: RerankingConfig;
  historyDbPath?: string | null;
  customPrompt?: string;
  disableHistory?: boolean;
  version?: string;
};

// ── Memory Items ──────────────────────────────────────────────────────

export type MemoryItem = {
  id: string;
  content: string;
  hash?: string;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  score?: number;
};

// ── Search / Filters ──────────────────────────────────────────────────

export type SearchFilters = {
  userId?: string;
  agentId?: string;
  runId?: string;
  [key: string]: unknown;
};

export type VectorStoreResult = {
  id: string;
  payload: Record<string, unknown>;
  score: number;
};

// ── LLM Response ──────────────────────────────────────────────────────

export type LLMResponse = {
  content: string;
  role: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
};

// ── Memory Operations (returned by LLM during add) ───────────────────

export type MemoryOperation = {
  event: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE';
  id?: string;
  text?: string;
  oldMemory?: string;
  newMemory?: string;
};
