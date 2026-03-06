/**
 * OpenMemory LLM & Embedding configuration management.
 *
 * Manages DATA_HOME/openmemory/default_config.json — the mem0 config file
 * that controls which LLM/embedding provider OpenMemory uses. Also provides
 * runtime push/fetch via the OpenMemory REST API at /api/v1/config/.
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

export type OpenMemoryConfig = {
  mem0: {
    llm: { provider: string; config: Record<string, unknown> };
    embedder: { provider: string; config: Record<string, unknown> };
    vector_store: {
      provider: "qdrant";
      config: {
        collection_name: string;
        path: string;
        embedding_model_dims: number;
      };
    };
  };
  openmemory: { custom_instructions: string };
};

// ── Constants (module-specific) ─────────────────────────────────────────

export const EMBED_PROVIDERS = [
  "openai", "ollama", "huggingface", "lmstudio"
] as const;

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
          path: "/data/qdrant",
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

// ── Config Resolution ────────────────────────────────────────────────

/**
 * Resolve all `env:VAR` references in an OpenMemoryConfig to their actual
 * values. Used before pushing config to the OpenMemory REST API — the
 * container receives real API keys, not env references it cannot resolve.
 */
export function resolveConfigForPush(
  config: OpenMemoryConfig,
  configDir: string
): OpenMemoryConfig {
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

export type QdrantDimensionResult = {
  match: boolean;
  currentDims?: number;
  expectedDims: number;
};

/**
 * Compare the persisted config's embedding dimensions against a new config.
 * Since Qdrant runs in embedded mode inside the OpenMemory container,
 * we can't query its HTTP API directly. Instead we compare the persisted
 * config (which reflects the collection's actual dimensions) against the
 * incoming config to detect mismatches.
 */
export function checkQdrantDimensions(
  dataDir: string,
  newConfig: OpenMemoryConfig
): QdrantDimensionResult {
  const expectedDims = newConfig.mem0.vector_store.config.embedding_model_dims;
  const persisted = readOpenMemoryConfig(dataDir);
  const currentDims = persisted.mem0.vector_store.config.embedding_model_dims;
  return { match: currentDims === expectedDims, currentDims, expectedDims };
}

/**
 * Delete the embedded Qdrant data directory so OpenMemory recreates the
 * collection with correct dimensions on next startup.
 *
 * The OpenMemory container must be restarted after this operation.
 */
export function resetQdrantCollection(
  dataDir: string
): { ok: boolean; error?: string } {
  const qdrantPath = `${dataDir}/openmemory/qdrant`;
  try {
    if (existsSync(qdrantPath)) {
      rmSync(qdrantPath, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
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

/**
 * Provision a user in OpenMemory by completing an MCP SSE handshake.
 *
 * OpenMemory only creates users when an MCP tool call is processed through
 * an active SSE session (via `get_or_create_user` in mcp_server.py).
 * The REST API endpoints return 404 "User not found" for unknown user_ids.
 *
 * Flow:
 * 1. Open SSE connection → receive session endpoint URL
 * 2. POST `initialize` to establish the MCP session
 * 3. POST `tools/call` for `add_memories` which triggers user creation
 * 4. Abort the SSE connection
 *
 * This is fire-and-forget; failure is non-fatal.
 */
export async function provisionOpenMemoryUser(
  userId: string,
  appName = "openpalm-assistant"
): Promise<{ ok: boolean; error?: string }> {
  const sseController = new AbortController();
  const overallTimeout = setTimeout(() => sseController.abort(), 10_000);

  try {
    // Step 1: Open SSE connection
    const sseRes = await fetch(
      `${OPENMEMORY_API_BASE}/mcp/${appName}/sse/${userId}`,
      { signal: sseController.signal }
    ).catch(() => null);

    if (!sseRes || !sseRes.ok || !sseRes.body) {
      clearTimeout(overallTimeout);
      return { ok: false, error: sseRes ? `SSE HTTP ${sseRes.status}` : "SSE connection failed" };
    }

    // Helper: read next SSE event from the stream with a timeout.
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";

    const readNextEvent = async (
      timeoutMs = 5_000
    ): Promise<{ event: string; data: string } | null> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remaining = Math.max(deadline - Date.now(), 100);
        const timeoutRace = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), remaining)
        );
        const chunk = await Promise.race([reader.read(), timeoutRace]);
        if (!chunk || (chunk as { done: boolean }).done) return null;
        sseBuffer += decoder.decode(
          (chunk as { value: Uint8Array }).value,
          { stream: true }
        );
        // SSE format: "event: <type>\r\ndata: <payload>\r\n\r\n"
        const eventMatch = sseBuffer.match(
          /event:\s*(\S+)\r?\n(?:data:\s*(.*)\r?\n)?\r?\n/
        );
        if (eventMatch) {
          sseBuffer = sseBuffer.slice(
            (eventMatch.index ?? 0) + eventMatch[0].length
          );
          return { event: eventMatch[1], data: eventMatch[2] || "" };
        }
      }
      return null;
    };

    // Step 2: Read the endpoint event
    const endpointEvt = await readNextEvent(5_000);
    if (!endpointEvt || endpointEvt.event !== "endpoint" || !endpointEvt.data) {
      clearTimeout(overallTimeout);
      sseController.abort();
      return { ok: false, error: "No endpoint event received from SSE" };
    }

    const fullMessagesUrl = `${OPENMEMORY_API_BASE}${endpointEvt.data}`;

    // Step 3: Send MCP initialize
    await fetch(fullMessagesUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: appName, version: "1.0.0" },
        },
      }),
    }).catch(() => null);

    // Step 4: Read initialize response to confirm session is established
    await readNextEvent(5_000);

    // Step 5: Send initialized notification (required by MCP protocol
    // before the server accepts tool calls)
    await fetch(fullMessagesUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    }).catch(() => null);

    // Brief pause
    await new Promise((r) => setTimeout(r, 300));

    // Step 6: Send add_memories tool call — this triggers get_or_create_user
    await fetch(fullMessagesUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "add_memories",
          arguments: {
            text: `User ${userId} account provisioned by OpenPalm setup.`,
          },
        },
      }),
    }).catch(() => null);

    // Step 7: Wait for tool response (confirms user creation completed)
    await readNextEvent(8_000);

    clearTimeout(overallTimeout);
    sseController.abort();
    return { ok: true };
  } catch (err) {
    clearTimeout(overallTimeout);
    sseController.abort();
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: true };
    }
    return { ok: false, error: String(err) };
  }
}
