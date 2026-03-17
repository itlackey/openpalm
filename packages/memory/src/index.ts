/**
 * @openpalm/memory — Public API barrel export.
 *
 * Usage:
 *   import { Memory } from '@openpalm/memory';
 *   const mem = new Memory({ ... });
 *   await mem.initialize();
 *   await mem.add("User prefers TypeScript", { userId: "alice" });
 *   const results = await mem.search("programming", { userId: "alice" });
 */

// Core class
export { Memory } from './memory.js';
export type { AddOptions, SearchOptions, GetAllOptions } from './memory.js';

// Types
export type {
  Message,
  MemoryConfig,
  MemoryItem,
  MemoryOperation,
  SearchFilters,
  VectorStoreResult,
  LLMResponse,
  LLMProviderConfig,
  EmbedderProviderConfig,
  VectorStoreProviderConfig,
} from './types.js';

// Config
export { resolveConfig } from './config.js';

// Interfaces (for custom adapter implementations)
export type { LLM } from './llms/base.js';
export type { Embedder } from './embeddings/base.js';
export type { VectorStore } from './vector-stores/base.js';
export type { HistoryManager, HistoryEntry } from './storage/base.js';

// Concrete implementations (for direct use or testing)
export { SqliteVecStore } from './vector-stores/sqlite-vec.js';
export { SqliteHistoryManager } from './storage/sqlite.js';
export { OpenAILLM } from './llms/openai.js';
export { OllamaLLM } from './llms/ollama.js';
export { LMStudioLLM } from './llms/lmstudio.js';
export { OpenAIEmbedder } from './embeddings/openai.js';
export { OllamaEmbedder } from './embeddings/ollama.js';

// Factories
export { createLLM } from './llms/index.js';
export { createEmbedder } from './embeddings/index.js';
export { createVectorStore } from './vector-stores/index.js';
export { createHistoryManager } from './storage/index.js';
