/**
 * Shared config-building logic for the memory service.
 * Extracted so tests can import without triggering Bun.serve() side-effects.
 */
import type { MemoryConfig } from '@openpalm/memory';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Build a MemoryConfig directly from environment variables (injected via managed.env + compose).
 * Returns null if SYSTEM_LLM_PROVIDER is not set (env-based config not available).
 *
 * @param env - Environment variable map (defaults to process.env)
 * @param dataDir - Data directory for sqlite DB path (optional, omits dbPath when not provided)
 */
export function buildConfigFromEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  dataDir?: string,
): MemoryConfig | null {
  const provider = env.SYSTEM_LLM_PROVIDER;
  if (!provider) return null;

  const model = env.SYSTEM_LLM_MODEL || undefined;
  const baseUrl = env.SYSTEM_LLM_BASE_URL || undefined;
  const embeddingModel = env.EMBEDDING_MODEL || undefined;
  const embeddingDimsEnv = env.EMBEDDING_DIMS;
  let embeddingDims = 1536;
  if (embeddingDimsEnv) {
    const parsedDims = parseInt(embeddingDimsEnv, 10);
    if (!Number.isNaN(parsedDims) && parsedDims > 0) {
      embeddingDims = parsedDims;
    } else {
      console.warn(`[config] Invalid EMBEDDING_DIMS value "${embeddingDimsEnv}", falling back to default 1536`);
    }
  }

  // Resolve API key: check provider-specific key first, then fall back to OPENAI_API_KEY
  const providerKeyName = `${provider.toUpperCase()}_API_KEY`;
  const apiKey = env[providerKeyName] || env.OPENAI_API_KEY || undefined;

  // Resolve LLM base URL: explicit env var, then provider-specific defaults
  let llmBaseUrl = baseUrl;
  if (!llmBaseUrl && provider === 'ollama') {
    llmBaseUrl = 'http://host.docker.internal:11434';
  }
  // Also check OPENAI_BASE_URL for openai-compatible providers
  if (!llmBaseUrl && env.OPENAI_BASE_URL) {
    llmBaseUrl = env.OPENAI_BASE_URL;
  }

  // Determine embedder provider from model name
  let embedderProvider = provider;
  if (embeddingModel) {
    if (embeddingModel.startsWith('nomic-') || embeddingModel.includes('ollama')) {
      embedderProvider = 'ollama';
    }
  }

  // Resolve embedder API key and base URL
  const embedderKeyName = `${embedderProvider.toUpperCase()}_API_KEY`;
  const embedderApiKey = env[embedderKeyName] || env.OPENAI_API_KEY || undefined;
  let embedderBaseUrl: string | undefined;
  if (embedderProvider === 'ollama') {
    embedderBaseUrl = env.EMBEDDING_BASE_URL || 'http://host.docker.internal:11434';
  } else if (env.OPENAI_BASE_URL) {
    embedderBaseUrl = env.OPENAI_BASE_URL;
  }

  // Build vectorStore config — include dbPath only when dataDir is provided
  const vectorStoreConfig: Record<string, unknown> = {
    collectionName: 'memory',
    dimensions: embeddingDims,
  };
  if (dataDir) {
    const dbPath = join(dataDir, 'memory.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    vectorStoreConfig.dbPath = dbPath;
  }

  console.log(`[config] Using env-based config: provider=${provider}, model=${model ?? 'default'}, embedder=${embedderProvider}/${embeddingModel ?? 'default'}`);

  return {
    llm: {
      provider,
      config: {
        model,
        apiKey,
        baseUrl: llmBaseUrl,
      },
    },
    embedder: {
      provider: embedderProvider,
      config: {
        model: embeddingModel,
        apiKey: embedderApiKey,
        baseUrl: embedderBaseUrl,
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
