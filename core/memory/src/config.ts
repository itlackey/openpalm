/**
 * Build a MemoryConfig from environment variables (injected via compose OP_CAP_* mapping).
 * All values are pre-resolved by the control plane — no fallback chains needed.
 */
import type { MemoryConfig } from '@openpalm/memory';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

  console.log(`[config] Using env-based config: provider=${provider}, model=${env.SYSTEM_LLM_MODEL ?? 'default'}, embedder=${env.EMBEDDING_PROVIDER ?? provider}/${env.EMBEDDING_MODEL ?? 'default'}`);

  return {
    llm: {
      provider,
      config: {
        model: env.SYSTEM_LLM_MODEL || undefined,
        apiKey: env.SYSTEM_LLM_API_KEY || undefined,
        baseUrl: env.SYSTEM_LLM_BASE_URL || undefined,
      },
    },
    embedder: {
      provider: env.EMBEDDING_PROVIDER || provider,
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
}
