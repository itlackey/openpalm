/**
 * Memory LLM & Embedding configuration management.
 *
 * Manages DATA_HOME/memory/default_config.json — the mem0 config file
 * that controls which LLM/embedding provider the memory service uses.
 * Also provides runtime push/fetch via the Memory REST API at /api/v1/config/.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { loadSecretsEnvFile } from "./secrets.js";
import {
  LLM_PROVIDERS,
  EMBEDDING_DIMS,
  PROVIDER_DEFAULT_URLS,
} from "../provider-constants.js";

// Re-export shared constants for barrel compatibility
export { LLM_PROVIDERS, EMBEDDING_DIMS, PROVIDER_DEFAULT_URLS };

// ── Types ────────────────────────────────────────────────────────────────

export type MemoryConfig = {
  mem0: {
    llm: { provider: string; config: Record<string, unknown> };
    embedder: { provider: string; config: Record<string, unknown> };
    vector_store: {
      provider: "sqlite-vec" | "qdrant";
      config: {
        collection_name: string;
        db_path?: string;
        path?: string;
        embedding_model_dims: number;
      };
    };
  };
  memory: { custom_instructions: string };
};

// ── Constants (module-specific) ─────────────────────────────────────────

export const EMBED_PROVIDERS = [
  "openai", "ollama", "huggingface", "lmstudio"
] as const;

/** Static model list for Anthropic (no listing API available). Keep current with new releases. */
const ANTHROPIC_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5-20251001",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
];

// ── API Key Resolution ──────────────────────────────────────────────────

/**
 * Resolve an API key reference to its actual value.
 * If the ref starts with "env:", look up the var name from process.env first,
 * then fall back to CONFIG_HOME/secrets.env.
 * Otherwise return the raw value.
 */
export function resolveApiKey(apiKeyRef: string, configDir: string): string {
  if (!apiKeyRef) return "";
  if (!apiKeyRef.startsWith("env:")) return apiKeyRef;

  const varName = apiKeyRef.slice(4);
  if (process.env[varName]) return process.env[varName]!;

  const secrets = loadSecretsEnvFile(configDir);
  return secrets[varName] ?? "";
}

// ── Provider Model Listing ──────────────────────────────────────────────

export type ModelDiscoveryReason =
  | 'none'
  | 'provider_static'
  | 'provider_http'
  | 'missing_base_url'
  | 'timeout'
  | 'network';

export type ProviderModelsResult = {
  models: string[];
  status: 'ok' | 'recoverable_error';
  reason: ModelDiscoveryReason;
  error?: string;
};

/**
 * Fetch available models from a provider's API.
 * Returns { models, error? } — never throws.
 */
export async function fetchProviderModels(
  provider: string,
  apiKeyRef: string,
  baseUrl: string,
  configDir: string
): Promise<ProviderModelsResult> {
  try {
    // Anthropic: no listing API — return static list
    if (provider === "anthropic") {
      return { models: [...ANTHROPIC_MODELS], status: 'ok', reason: 'provider_static' };
    }

    const resolvedKey = resolveApiKey(apiKeyRef, configDir);

    // Ollama: different API shape, no auth
    if (provider === "ollama") {
      const base = baseUrl?.trim() || PROVIDER_DEFAULT_URLS.ollama;
      const url = `${base.replace(/\/+$/, "")}/api/tags`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        return {
          models: [],
          status: 'recoverable_error',
          reason: 'provider_http',
          error: `Ollama API returned ${res.status}`,
        };
      }
      const data = (await res.json()) as { models?: { name: string }[] };
      const models = (data.models ?? []).map((m) => m.name).sort();
      return { models, status: 'ok', reason: 'none' };
    }

    // OpenAI-compatible providers
    const base = baseUrl?.trim() || PROVIDER_DEFAULT_URLS[provider] || "";
    if (!base) {
      return {
        models: [],
        status: 'recoverable_error',
        reason: 'missing_base_url',
        error: `No base URL configured for provider "${provider}"`,
      };
    }
    const url = `${base.replace(/\/+$/, "")}/v1/models`;

    const headers: Record<string, string> = {};
    if (resolvedKey) {
      headers["Authorization"] = `Bearer ${resolvedKey}`;
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return {
        models: [],
        status: 'recoverable_error',
        reason: 'provider_http',
        error: `Provider API returned ${res.status}`,
      };
    }
    const data = (await res.json()) as { data?: { id: string }[] };
    const models = (data.data ?? []).map((m) => m.id).sort();
    return { models, status: 'ok', reason: 'none' };
  } catch (err) {
    const message =
      err instanceof Error && err.name === "TimeoutError"
        ? "Request timed out after 5s"
        : String(err);
    return {
      models: [],
      status: 'recoverable_error',
      reason: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network',
      error: message,
    };
  }
}

// ── Default Config ───────────────────────────────────────────────────────

export function getDefaultConfig(): MemoryConfig {
  return {
    mem0: {
      llm: {
        provider: "openai",
        config: {
          model: "gpt-4o-mini",
          temperature: 0.1,
          max_tokens: 2000,
          api_key: "env:OPENAI_API_KEY",
        },
      },
      embedder: {
        provider: "openai",
        config: {
          model: "text-embedding-3-small",
          api_key: "env:OPENAI_API_KEY",
        },
      },
      vector_store: {
        provider: "sqlite-vec",
        config: {
          collection_name: "memory",
          db_path: "/data/memory.db",
          embedding_model_dims: 1536,
        },
      },
    },
    memory: { custom_instructions: "" },
  };
}

// ── File I/O ─────────────────────────────────────────────────────────────

const CONFIG_FILENAME = "memory/default_config.json";

function configPath(dataDir: string): string {
  return `${dataDir}/${CONFIG_FILENAME}`;
}

export function readMemoryConfig(dataDir: string): MemoryConfig {
  const path = configPath(dataDir);
  if (!existsSync(path)) return getDefaultConfig();
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as MemoryConfig;
  } catch {
    return getDefaultConfig();
  }
}

export function writeMemoryConfig(
  dataDir: string,
  config: MemoryConfig
): void {
  const path = configPath(dataDir);
  mkdirSync(`${dataDir}/memory`, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

export function ensureMemoryConfig(dataDir: string): void {
  const path = configPath(dataDir);
  if (existsSync(path)) return;
  writeMemoryConfig(dataDir, getDefaultConfig());
}

// ── Config Resolution ────────────────────────────────────────────────

/**
 * Resolve all `env:VAR` references in a MemoryConfig to their actual
 * values. Used before pushing config to the Memory REST API — the
 * container receives real API keys, not env references it cannot resolve.
 */
export function resolveConfigForPush(
  config: MemoryConfig,
  configDir: string
): MemoryConfig {
  const resolved = structuredClone(config);

  // Resolve LLM api_key
  if (typeof resolved.mem0.llm.config.api_key === "string") {
    resolved.mem0.llm.config.api_key = resolveApiKey(
      resolved.mem0.llm.config.api_key as string,
      configDir
    );
  }

  // Resolve embedder api_key
  if (typeof resolved.mem0.embedder.config.api_key === "string") {
    resolved.mem0.embedder.config.api_key = resolveApiKey(
      resolved.mem0.embedder.config.api_key as string,
      configDir
    );
  }

  return resolved;
}

// ── Dimension Checking ──────────────────────────────────────────────

export type VectorDimensionResult = {
  match: boolean;
  currentDims?: number;
  expectedDims: number;
};

/** @deprecated Use checkVectorDimensions instead */
export type QdrantDimensionResult = VectorDimensionResult;

/**
 * Compare the persisted config's embedding dimensions against a new config.
 * We compare the persisted config (which reflects the store's actual dimensions)
 * against the incoming config to detect mismatches.
 */
export function checkVectorDimensions(
  dataDir: string,
  newConfig: MemoryConfig
): VectorDimensionResult {
  const expectedDims = newConfig.mem0.vector_store.config.embedding_model_dims;
  const persisted = readMemoryConfig(dataDir);
  const currentDims = persisted.mem0.vector_store.config.embedding_model_dims;
  return { match: currentDims === expectedDims, currentDims, expectedDims };
}

/** @deprecated Use checkVectorDimensions instead */
export const checkQdrantDimensions = checkVectorDimensions;

/**
 * Delete the vector store data so the memory service recreates
 * the collection with correct dimensions on next startup.
 *
 * The memory container must be restarted after this operation.
 */
export function resetVectorStore(
  dataDir: string
): { ok: boolean; error?: string } {
  // Read persisted config to find the actual db_path
  const persisted = readMemoryConfig(dataDir);
  const configuredPath = persisted.mem0.vector_store.config.db_path;

  // Translate container-style paths (e.g. /data/memory.db) to the host
  // DATA_HOME equivalent. The container's /data mount maps to
  // ${dataDir}/memory on the host, so replace /data/ with ${dataDir}/memory/.
  let dbPath: string;
  if (configuredPath && configuredPath.startsWith('/data/')) {
    dbPath = `${dataDir}/memory/${configuredPath.slice('/data/'.length)}`;
  } else if (configuredPath && !configuredPath.startsWith('/')) {
    // Relative path — resolve under dataDir/memory/
    dbPath = `${dataDir}/memory/${configuredPath}`;
  } else {
    dbPath = `${dataDir}/memory/memory.db`;
  }
  // Also remove legacy Qdrant data if it exists
  const qdrantPath = `${dataDir}/memory/qdrant`;
  try {
    if (existsSync(dbPath)) {
      rmSync(dbPath, { force: true });
    }
    // Also clean WAL/SHM files
    for (const suffix of ['-wal', '-shm']) {
      const walPath = `${dbPath}${suffix}`;
      if (existsSync(walPath)) rmSync(walPath, { force: true });
    }
    if (existsSync(qdrantPath)) {
      rmSync(qdrantPath, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** @deprecated Use resetVectorStore instead */
export const resetQdrantCollection = resetVectorStore;

// ── Runtime API ──────────────────────────────────────────────────────────

const MEMORY_API_BASE = "http://memory:8765";

export async function pushConfigToMemory(
  config: MemoryConfig
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${MEMORY_API_BASE}/api/v1/config/`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function fetchConfigFromMemory(): Promise<MemoryConfig | null> {
  try {
    const res = await fetch(`${MEMORY_API_BASE}/api/v1/config/`);
    if (!res.ok) return null;
    return (await res.json()) as MemoryConfig;
  } catch {
    return null;
  }
}

/**
 * Provision a user in the memory service via simple REST call.
 * The lightweight memory API accepts this as a no-op (mem0 SDK doesn't need
 * explicit user provisioning). This is fire-and-forget; failure is non-fatal.
 */
export async function provisionMemoryUser(
  userId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${MEMORY_API_BASE}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: res.ok };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
