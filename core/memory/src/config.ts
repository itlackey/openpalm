/**
 * Build a MemoryConfig from a config file with env var substitution,
 * following the same pattern as OpenViking's ov.conf.
 *
 * The config file (memory.conf.json) uses ${VAR} placeholders that are
 * expanded from the container's environment variables at startup.
 * Falls back to building config directly from env vars if no config
 * file is available.
 */
import type { MemoryConfig } from '@openpalm/memory';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
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

/**
 * Expand ${VAR} placeholders in a string using environment variables.
 * Supports ${VAR:-default} syntax for defaults.
 * Unresolved placeholders are replaced with empty string.
 */
export function expandEnvVars(
  template: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  return template.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_match, name, fallback) => {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
    return fallback ?? '';
  });
}

/**
 * Load and parse a memory config file, expanding env var placeholders.
 * Returns null if the file doesn't exist.
 */
export function loadConfigFile(
  configPath: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): MemoryConfig | null {
  if (!existsSync(configPath)) return null;

  try {
    const template = readFileSync(configPath, 'utf-8');
    const expanded = expandEnvVars(template, env);

    // Parse the expanded JSON, tolerating empty numeric values by
    // replacing bare empty values with sensible defaults before parsing
    const sanitized = expanded
      .replace(/:\s*,/g, ': null,')       // trailing comma after empty value
      .replace(/:\s*\}/g, ': null}')       // empty value before closing brace
      .replace(/:\s*$/gm, ': null');       // empty value at end of line

    const raw = JSON.parse(sanitized) as Record<string, unknown>;
    return normalizeConfig(raw, env);
  } catch (err) {
    console.warn(`[config] Failed to load config file ${configPath}: ${err}`);
    return null;
  }
}

/**
 * Normalize a raw parsed config object into a MemoryConfig, applying
 * provider name mapping and cleaning up null/empty values.
 */
function normalizeConfig(
  raw: Record<string, unknown>,
  env: Record<string, string | undefined>,
): MemoryConfig {
  const llmRaw = raw.llm as Record<string, unknown> | undefined;
  const embedRaw = raw.embedder as Record<string, unknown> | undefined;
  const vsRaw = raw.vectorStore as Record<string, unknown> | undefined;
  const rrRaw = raw.reranking as Record<string, unknown> | undefined;

  const llmProvider = String(llmRaw?.provider || env.SYSTEM_LLM_PROVIDER || 'openai');
  const llmConfig = (llmRaw?.config || {}) as Record<string, unknown>;
  const embedProvider = String(embedRaw?.provider || env.EMBEDDING_PROVIDER || llmProvider);
  const embedConfig = (embedRaw?.config || {}) as Record<string, unknown>;
  const vsConfig = (vsRaw?.config || {}) as Record<string, unknown>;

  const config: MemoryConfig = {
    llm: {
      provider: memoryProviderName(llmProvider),
      config: {
        model: nonEmpty(llmConfig.model) || undefined,
        apiKey: nonEmpty(llmConfig.apiKey) || undefined,
        baseUrl: nonEmpty(llmConfig.baseUrl) || undefined,
      },
    },
    embedder: {
      provider: memoryProviderName(embedProvider),
      config: {
        model: nonEmpty(embedConfig.model) || undefined,
        apiKey: nonEmpty(embedConfig.apiKey) || undefined,
        baseUrl: nonEmpty(embedConfig.baseUrl) || undefined,
        dimensions: toInt(embedConfig.dimensions) || undefined,
      },
    },
    vectorStore: {
      provider: String(vsRaw?.provider || 'sqlite-vec'),
      config: {
        collectionName: nonEmpty(vsConfig.collectionName) || 'memory',
        dbPath: nonEmpty(vsConfig.dbPath) || undefined,
        dimensions: toInt(vsConfig.dimensions) || undefined,
      },
    },
    historyDbPath: null,
  };

  // Reranking
  if (rrRaw && (rrRaw.enabled === true || rrRaw.enabled === 'true') && nonEmpty(rrRaw.provider)) {
    config.reranking = {
      enabled: true,
      provider: nonEmpty(rrRaw.provider) || undefined,
      model: nonEmpty(rrRaw.model) || undefined,
      apiKey: nonEmpty(rrRaw.apiKey) || undefined,
      baseUrl: nonEmpty(rrRaw.baseUrl) || undefined,
      topK: toInt(rrRaw.topK) || undefined,
      topN: toInt(rrRaw.topN) || undefined,
    };
  }

  return config;
}

function nonEmpty(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined;
  const s = String(val).trim();
  return s || undefined;
}

function toInt(val: unknown): number | undefined {
  if (val === null || val === undefined) return undefined;
  const n = typeof val === 'number' ? val : parseInt(String(val), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ── Fallback: build config from env vars (backward compatibility) ────

export function buildConfigFromEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  dataDir?: string,
  configPath?: string,
): MemoryConfig | null {
  // Try config file first (OpenViking pattern)
  if (configPath) {
    const fileConfig = loadConfigFile(configPath, env);
    if (fileConfig) {
      // Override dbPath if dataDir is provided and config doesn't specify one
      if (dataDir && !fileConfig.vectorStore?.config?.dbPath) {
        const dbPath = join(dataDir, 'memory.db');
        mkdirSync(dirname(dbPath), { recursive: true });
        if (!fileConfig.vectorStore) {
          fileConfig.vectorStore = { provider: 'sqlite-vec', config: { dbPath } };
        } else {
          fileConfig.vectorStore.config = { ...fileConfig.vectorStore.config, dbPath };
        }
      }
      const debugLogging = env.MEMORY_DEBUG === '1' || env.MEMORY_DEBUG === 'true';
      if (debugLogging) {
        console.log(`[config] Loaded from config file: ${configPath}`);
      }
      return fileConfig;
    }
  }

  // Fallback: build directly from env vars
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
