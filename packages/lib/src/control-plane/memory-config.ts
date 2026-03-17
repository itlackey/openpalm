/**
 * Memory LLM & Embedding configuration management.
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

/** Static model list for Anthropic (no listing API available). */
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

function describeHttpStatus(status: number): string {
  switch (status) {
    case 401: return 'Invalid or missing API key';
    case 403: return 'Access denied — check API key permissions';
    case 404: return 'Endpoint not found — verify the base URL';
    case 429: return 'Rate limited — try again shortly';
    case 500: return 'Provider internal error';
    case 502: return 'Provider returned a bad gateway error';
    case 503: return 'Provider is temporarily unavailable';
    default:  return `HTTP ${status}`;
  }
}

async function extractProviderErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof json.error === 'object' && json.error !== null &&
      typeof (json.error as Record<string, unknown>).message === 'string'
    ) {
      return (json.error as Record<string, unknown>).message as string;
    }
    if (typeof json.error === 'string') return json.error;
    if (typeof json.message === 'string') return json.message;
    if (typeof json.detail === 'string') return json.detail;
    return '';
  } catch {
    return '';
  }
}

export async function fetchProviderModels(
  provider: string,
  apiKeyRef: string,
  baseUrl: string,
  configDir: string
): Promise<ProviderModelsResult> {
  try {
    if (provider === "anthropic") {
      return { models: [...ANTHROPIC_MODELS], status: 'ok', reason: 'provider_static' };
    }

    const resolvedKey = resolveApiKey(apiKeyRef, configDir);

    if (provider === "ollama") {
      const base = baseUrl?.trim() || PROVIDER_DEFAULT_URLS.ollama;
      const url = `${base.replace(/\/+$/, "")}/api/tags`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        return {
          models: [],
          status: 'recoverable_error',
          reason: 'provider_http',
          error: `Ollama API returned ${res.status}: ${describeHttpStatus(res.status)}`,
        };
      }
      const data = (await res.json()) as { models?: { name: string }[] };
      const models = (data.models ?? []).map((m) => m.name).sort();
      return { models, status: 'ok', reason: 'none' };
    }

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
      const detail = await extractProviderErrorDetail(res);
      return {
        models: [],
        status: 'recoverable_error',
        reason: 'provider_http',
        error: detail
          ? `Provider API returned ${res.status}: ${detail}`
          : `Provider API returned ${res.status}: ${describeHttpStatus(res.status)}`,
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

export function resolveConfigForPush(
  config: MemoryConfig,
  configDir: string
): MemoryConfig {
  const resolved = structuredClone(config);

  if (typeof resolved.mem0.llm.config.api_key === "string") {
    resolved.mem0.llm.config.api_key = resolveApiKey(
      resolved.mem0.llm.config.api_key as string,
      configDir
    );
  }

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

export function resetVectorStore(
  dataDir: string
): { ok: boolean; error?: string } {
  const persisted = readMemoryConfig(dataDir);
  const configuredPath = persisted.mem0.vector_store.config.db_path;

  let dbPath: string;
  if (configuredPath && configuredPath.startsWith('/data/')) {
    dbPath = `${dataDir}/memory/${configuredPath.slice('/data/'.length)}`;
  } else if (configuredPath && !configuredPath.startsWith('/')) {
    dbPath = `${dataDir}/memory/${configuredPath}`;
  } else {
    dbPath = `${dataDir}/memory/memory.db`;
  }
  const qdrantPath = `${dataDir}/memory/qdrant`;
  try {
    if (existsSync(dbPath)) {
      rmSync(dbPath, { force: true });
    }
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

function getMemoryApiBases(): string[] {
  const configured =
    process.env.MEMORY_API_URL?.trim() ||
    process.env.OPENPALM_MEMORY_API_URL?.trim();

  const bases = configured
    ? [configured]
    : ["http://memory:8765", "http://127.0.0.1:8765"];

  return Array.from(new Set(bases.map((base) => base.replace(/\/+$/, ""))));
}

function getMemoryAuthHeaders(): Record<string, string> {
  const token = process.env.MEMORY_AUTH_TOKEN?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function callMemoryApi(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const bases = getMemoryApiBases();
  const authHeaders = getMemoryAuthHeaders();
  let lastError: unknown;

  for (let i = 0; i < bases.length; i++) {
    const url = `${bases[i]}${path}`;
    try {
      const headers = { ...authHeaders, ...(init?.headers as Record<string, string>) };
      return await fetch(url, { ...init, headers });
    } catch (err) {
      lastError = err;
      if (i === bases.length - 1) throw err;
    }
  }

  throw lastError ?? new Error("Memory API request failed");
}

export async function pushConfigToMemory(
  config: MemoryConfig
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await callMemoryApi("/api/v1/config/", {
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
    const res = await callMemoryApi("/api/v1/config/");
    if (!res.ok) return null;
    return (await res.json()) as MemoryConfig;
  } catch {
    return null;
  }
}

export async function provisionMemoryUser(
  userId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await callMemoryApi("/api/v1/users", {
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
