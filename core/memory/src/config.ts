/**
 * Build a MemoryConfig from environment variables (injected via compose OP_CAP_* mapping).
 * All values are pre-resolved by the control plane — no fallback chains needed.
 */
import type { MemoryConfig } from '@openpalm/memory';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Map an OpenPalm provider name to a @openpalm/memory adapter name.
 * Memory only supports: openai, ollama, lmstudio.
 * All OpenAI-compatible cloud providers (groq, mistral, deepseek, etc.)
 * and custom/local providers work through the openai adapter since
 * the base URL and API key are already resolved by the control plane.
 */
function memoryProviderName(provider: string): string {
  switch (provider) {
    case 'ollama':
      return 'ollama';
    case 'lmstudio':
      return 'lmstudio';
    case 'openai-compatible':
      return 'openai';
    default:
      return 'openai';
  }
}

export function buildConfigFromEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  dataDir?: string,
): MemoryConfig | null {
  const provider = env.SYSTEM_LLM_PROVIDER;
  if (!provider) return null;

  const embeddingDims = parseInt(env.EMBEDDING_DIMS || '1536', 10) || 1536;

  const vectorStoreConfig: Record<string, unknown> = {
    collectionName: 'memory',
    dimensions: embeddingDims,
  };
  if (dataDir) {
    const dbPath = join(dataDir, 'memory.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    vectorStoreConfig.dbPath = dbPath;
  }

  const debugLogging = env.MEMORY_DEBUG === '1' || env.MEMORY_DEBUG === 'true';
  if (debugLogging) {
    console.log(`[config] Using env-based config: provider=${provider}, model=${env.SYSTEM_LLM_MODEL ?? 'default'}, embedder=${env.EMBEDDING_PROVIDER ?? provider}/${env.EMBEDDING_MODEL ?? 'default'}`);
  }

  const config: MemoryConfig = {
    llm: {
      provider: memoryProviderName(provider),
      config: {
        model: env.SYSTEM_LLM_MODEL || undefined,
        apiKey: env.SYSTEM_LLM_API_KEY || undefined,
        baseUrl: env.SYSTEM_LLM_BASE_URL || undefined,
      },
    },
    embedder: {
      provider: memoryProviderName(env.EMBEDDING_PROVIDER || provider),
      config: {
        model: env.EMBEDDING_MODEL || undefined,
        apiKey: env.EMBEDDING_API_KEY || undefined,
        baseUrl: env.EMBEDDING_BASE_URL || undefined,
        dimensions: embeddingDims,
      },
    },
    vectorStore: {
      provider: 'sqlite-vec',
      config: vectorStoreConfig,
    },
    historyDbPath: null,
  };

  // Add reranking config if enabled
  if (env.RERANKING_ENABLED === 'true' && env.RERANKING_PROVIDER) {
    config.reranking = {
      enabled: true,
      provider: env.RERANKING_PROVIDER,
      model: env.RERANKING_MODEL || undefined,
      apiKey: env.RERANKING_API_KEY || undefined,
      baseUrl: env.RERANKING_BASE_URL || undefined,
      topK: env.RERANKING_TOP_K ? parseInt(env.RERANKING_TOP_K, 10) : undefined,
      topN: env.RERANKING_TOP_N ? parseInt(env.RERANKING_TOP_N, 10) : undefined,
    };
  }

  return config;
}
