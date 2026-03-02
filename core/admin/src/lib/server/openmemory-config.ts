/**
 * OpenMemory LLM & Embedding configuration management.
 *
 * Manages DATA_HOME/openmemory/default_config.json — the mem0 config file
 * that controls which LLM/embedding provider OpenMemory uses. Also provides
 * runtime push/fetch via the OpenMemory REST API at /api/v1/config/.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { loadSecretsEnvFile } from "./secrets.js";

// ── Types ────────────────────────────────────────────────────────────────

export type OpenMemoryConfig = {
  mem0: {
    llm: { provider: string; config: Record<string, unknown> };
    embedder: { provider: string; config: Record<string, unknown> };
    vector_store: {
      provider: "qdrant";
      config: {
        collection_name: string;
        host: string;
        port: number;
        embedding_model_dims: number;
      };
    };
  };
  openmemory: { custom_instructions: string };
};

// ── Constants ────────────────────────────────────────────────────────────

export const LLM_PROVIDERS = [
  "openai", "anthropic", "ollama", "groq", "together",
  "mistral", "deepseek", "xai", "lmstudio"
] as const;

export const EMBED_PROVIDERS = [
  "openai", "ollama", "huggingface", "lmstudio"
] as const;

export const EMBEDDING_DIMS: Record<string, number> = {
  "openai/text-embedding-3-small": 1536,
  "openai/text-embedding-3-large": 3072,
  "openai/text-embedding-ada-002": 1536,
  "ollama/nomic-embed-text": 768,
  "ollama/mxbai-embed-large": 1024,
  "ollama/all-minilm": 384,
  "ollama/snowflake-arctic-embed": 1024,
};

/** Default base URLs per provider (used when no base_url is configured). */
const PROVIDER_DEFAULT_URLS: Record<string, string> = {
  openai: "https://api.openai.com",
  groq: "https://api.groq.com/openai",
  mistral: "https://api.mistral.ai",
  together: "https://api.together.xyz",
  deepseek: "https://api.deepseek.com",
  xai: "https://api.x.ai",
  lmstudio: "http://host.docker.internal:1234",
  ollama: "http://host.docker.internal:11434",
};

/** Static model list for Anthropic (no listing API available). */
const ANTHROPIC_MODELS = [
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

export type ProviderModelsResult = { models: string[]; error?: string };

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
      return { models: [...ANTHROPIC_MODELS] };
    }

    const resolvedKey = resolveApiKey(apiKeyRef, configDir);

    // Ollama: different API shape, no auth
    if (provider === "ollama") {
      const base = baseUrl?.trim() || PROVIDER_DEFAULT_URLS.ollama;
      const url = `${base.replace(/\/+$/, "")}/api/tags`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        return { models: [], error: `Ollama API returned ${res.status}` };
      }
      const data = (await res.json()) as { models?: { name: string }[] };
      const models = (data.models ?? []).map((m) => m.name).sort();
      return { models };
    }

    // OpenAI-compatible providers
    const base = baseUrl?.trim() || PROVIDER_DEFAULT_URLS[provider] || "";
    if (!base) {
      return { models: [], error: `No base URL configured for provider "${provider}"` };
    }
    const url = `${base.replace(/\/+$/, "")}/v1/models`;

    const headers: Record<string, string> = {};
    if (resolvedKey) {
      headers["Authorization"] = `Bearer ${resolvedKey}`;
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return { models: [], error: `Provider API returned ${res.status}` };
    }
    const data = (await res.json()) as { data?: { id: string }[] };
    const models = (data.data ?? []).map((m) => m.id).sort();
    return { models };
  } catch (err) {
    const message =
      err instanceof Error && err.name === "TimeoutError"
        ? "Request timed out after 5s"
        : String(err);
    return { models: [], error: message };
  }
}

// ── Default Config ───────────────────────────────────────────────────────

export function getDefaultConfig(): OpenMemoryConfig {
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
        provider: "qdrant",
        config: {
          collection_name: "openmemory",
          host: "qdrant",
          port: 6333,
          embedding_model_dims: 1536,
        },
      },
    },
    openmemory: { custom_instructions: "" },
  };
}

// ── File I/O ─────────────────────────────────────────────────────────────

const CONFIG_FILENAME = "openmemory/default_config.json";

function configPath(dataDir: string): string {
  return `${dataDir}/${CONFIG_FILENAME}`;
}

export function readOpenMemoryConfig(dataDir: string): OpenMemoryConfig {
  const path = configPath(dataDir);
  if (!existsSync(path)) return getDefaultConfig();
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as OpenMemoryConfig;
  } catch {
    return getDefaultConfig();
  }
}

export function writeOpenMemoryConfig(
  dataDir: string,
  config: OpenMemoryConfig
): void {
  const path = configPath(dataDir);
  mkdirSync(`${dataDir}/openmemory`, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

export function ensureOpenMemoryConfig(dataDir: string): void {
  const path = configPath(dataDir);
  if (existsSync(path)) return;
  writeOpenMemoryConfig(dataDir, getDefaultConfig());
}

// ── Runtime API ──────────────────────────────────────────────────────────

const OPENMEMORY_API_BASE = "http://openmemory:8765";

export async function pushConfigToOpenMemory(
  config: OpenMemoryConfig
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${OPENMEMORY_API_BASE}/api/v1/config/`, {
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

export async function fetchConfigFromOpenMemory(): Promise<OpenMemoryConfig | null> {
  try {
    const res = await fetch(`${OPENMEMORY_API_BASE}/api/v1/config/`);
    if (!res.ok) return null;
    return (await res.json()) as OpenMemoryConfig;
  } catch {
    return null;
  }
}
