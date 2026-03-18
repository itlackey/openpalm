/**
 * Shared setup orchestration for the OpenPalm control plane.
 *
 * Extracts the reusable core logic from the admin's POST /admin/setup handler
 * so that both the CLI setup wizard and the admin UI can call `performSetup()`.
 *
 * This module does NOT include Docker operations (compose up, image pull, etc.)
 * — those happen separately in the caller after setup completes.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createLogger } from "../logger.js";
import {
  PROVIDER_KEY_MAP,
  EMBEDDING_DIMS,
  OLLAMA_INSTACK_URL,
} from "../provider-constants.js";
import { mergeEnvContent } from "./env.js";
import { ensureXdgDirs } from "./paths.js";
import {
  ensureSecrets,
  updateSecretsEnv,
  ensureOpenCodeConfig,
} from "./secrets.js";
import { ensureConnectionProfilesStore, writeConnectionsDocument } from "./connection-profiles.js";
import { buildMem0Mapping } from "./connection-mapping.js";
import { writeMemoryConfig } from "./memory-config.js";
import { ensureOpenCodeSystemConfig, ensureAdminOpenCodeConfig, ensureMemoryDir } from "./core-assets.js";
import { applyInstall, createState, writeSetupTokenFile } from "./lifecycle.js";
import { writeStackSpec } from "./stack-spec.js";
import type { StackSpec } from "./stack-spec.js";
import { detectLocalProviders } from "./model-runner.js";
import type { LocalProviderDetection } from "./model-runner.js";
import type { CoreAssetProvider } from "./core-asset-provider.js";
import type { ControlPlaneState, CapabilityAssignments } from "./types.js";

const logger = createLogger("setup");

/** Apply Ollama in-stack URL override to connections when Ollama is enabled. */
function resolveOllamaUrls(connections: SetupConnection[], ollamaEnabled: boolean): SetupConnection[] {
  if (!ollamaEnabled) return connections;
  return connections.map((c) =>
    c.provider === "ollama" ? { ...c, baseUrl: OLLAMA_INSTACK_URL } : c
  );
}

// ── Types ────────────────────────────────────────────────────────────────

export type SetupConnection = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
};

export type SetupAssignments = {
  llm: { connectionId: string; model: string; smallModel?: string };
  embeddings: { connectionId: string; model: string; embeddingDims?: number };
};

export type SetupInput = {
  adminToken: string;
  ownerName?: string;
  ownerEmail?: string;
  memoryUserId: string;
  ollamaEnabled: boolean;
  connections: SetupConnection[];
  assignments: SetupAssignments;
};

export type SetupResult = {
  ok: boolean;
  error?: string;
  /** Services that should be started after setup. */
  started?: string[];
};

export type DetectedProvider = {
  provider: string;
  url: string;
  available: boolean;
};

// ── Validation ───────────────────────────────────────────────────────────

/** Safe env var key pattern: uppercase alphanumeric + underscores, starting with a letter. */
const SAFE_ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/** Valid connection ID pattern: starts with letter or digit, allows A-Z, a-z, 0-9, _, -. */
const CONNECTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Providers that are valid for setup wizard connections. */
const WIZARD_PROVIDERS = new Set([
  "openai", "anthropic", "ollama", "groq", "together",
  "mistral", "deepseek", "xai", "lmstudio", "model-runner",
  "ollama-instack",
]);

export function validateSetupInput(input: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof input !== "object" || input === null) {
    return { valid: false, errors: ["Input must be a non-null object"] };
  }

  const body = input as Record<string, unknown>;

  // adminToken
  if (typeof body.adminToken !== "string" || !body.adminToken) {
    errors.push("adminToken is required and must be a non-empty string");
  } else if (body.adminToken.length < 8) {
    errors.push("adminToken must be at least 8 characters");
  }

  // ownerName and ownerEmail are optional strings
  if (body.ownerName !== undefined && typeof body.ownerName !== "string") {
    errors.push("ownerName must be a string if provided");
  }
  if (body.ownerEmail !== undefined && typeof body.ownerEmail !== "string") {
    errors.push("ownerEmail must be a string if provided");
  }

  // memoryUserId
  if (body.memoryUserId !== undefined && typeof body.memoryUserId !== "string") {
    errors.push("memoryUserId must be a string");
  }

  // ollamaEnabled
  if (body.ollamaEnabled !== undefined && typeof body.ollamaEnabled !== "boolean") {
    errors.push("ollamaEnabled must be a boolean");
  }

  // connections
  if (!Array.isArray(body.connections) || body.connections.length === 0) {
    errors.push("connections array is required and must be non-empty");
  } else {
    const seenIds = new Set<string>();
    for (let i = 0; i < body.connections.length; i++) {
      const c = body.connections[i];
      if (typeof c !== "object" || c === null) {
        errors.push(`connections[${i}] must be an object`);
        continue;
      }
      const conn = c as Record<string, unknown>;
      const id = typeof conn.id === "string" ? conn.id.trim() : "";
      const provider = typeof conn.provider === "string" ? conn.provider.trim() : "";

      if (!id) {
        errors.push(`connections[${i}].id is required`);
      } else if (!CONNECTION_ID_RE.test(id)) {
        errors.push(`connections[${i}].id must start with a letter or digit (allowed: A-Z, a-z, 0-9, _, -)`);
      } else if (seenIds.has(id)) {
        errors.push(`Duplicate connection ID: ${id}`);
      } else {
        seenIds.add(id);
      }

      const name = typeof conn.name === "string" ? conn.name.trim() : "";
      if (!name) {
        errors.push(`connections[${i}].name is required`);
      }

      if (!provider) {
        errors.push(`connections[${i}].provider is required`);
      } else if (!WIZARD_PROVIDERS.has(provider)) {
        errors.push(`connections[${i}].provider "${provider}" is outside wizard scope`);
      }
    }
  }

  // assignments
  if (typeof body.assignments !== "object" || body.assignments === null) {
    errors.push("assignments object is required");
  } else {
    const assignments = body.assignments as Record<string, unknown>;
    const llm = assignments.llm;
    const embeddings = assignments.embeddings;

    if (typeof llm !== "object" || llm === null) {
      errors.push("assignments.llm is required");
    } else {
      const llmObj = llm as Record<string, unknown>;
      if (!llmObj.connectionId || typeof llmObj.connectionId !== "string") {
        errors.push("assignments.llm.connectionId is required");
      }
      if (!llmObj.model || typeof llmObj.model !== "string") {
        errors.push("assignments.llm.model is required");
      }
    }

    if (typeof embeddings !== "object" || embeddings === null) {
      errors.push("assignments.embeddings is required");
    } else {
      const embObj = embeddings as Record<string, unknown>;
      if (!embObj.connectionId || typeof embObj.connectionId !== "string") {
        errors.push("assignments.embeddings.connectionId is required");
      }
      if (!embObj.model || typeof embObj.model !== "string") {
        errors.push("assignments.embeddings.model is required");
      }
      if (
        embObj.embeddingDims !== undefined &&
        (typeof embObj.embeddingDims !== "number" ||
          !Number.isInteger(embObj.embeddingDims) ||
          embObj.embeddingDims < 1)
      ) {
        errors.push("assignments.embeddings.embeddingDims must be a positive integer");
      }
    }

    // Cross-validate: assignment connectionIds must reference a connection
    if (Array.isArray(body.connections) && errors.length === 0) {
      const connectionIds = new Set(
        (body.connections as Array<Record<string, unknown>>).map(
          (c) => typeof c.id === "string" ? c.id.trim() : ""
        )
      );
      const llmConnId =
        typeof (llm as Record<string, unknown>)?.connectionId === "string"
          ? ((llm as Record<string, unknown>).connectionId as string)
          : "";
      const embConnId =
        typeof (embeddings as Record<string, unknown>)?.connectionId === "string"
          ? ((embeddings as Record<string, unknown>).connectionId as string)
          : "";

      if (llmConnId && !connectionIds.has(llmConnId)) {
        errors.push(`assignments.llm.connectionId "${llmConnId}" does not match any connection`);
      }
      if (embConnId && !connectionIds.has(embConnId)) {
        errors.push(`assignments.embeddings.connectionId "${embConnId}" does not match any connection`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Secrets Builder ──────────────────────────────────────────────────────

/**
 * Build the env var map from connections + assignments.
 *
 * Returns a Record<string, string> of secrets.env updates that should be
 * written during setup.
 */
export function buildSecretsFromSetup(input: SetupInput): Record<string, string> {
  const updates: Record<string, string> = {};

  // Admin token
  updates.OPENPALM_ADMIN_TOKEN = input.adminToken;
  updates.ADMIN_TOKEN = input.adminToken;

  // Owner info — strip control characters to prevent env-file injection
  const ownerName = (input.ownerName?.trim() ?? "").replace(/[\r\n\0]/g, "").slice(0, 200);
  const ownerEmail = (input.ownerEmail?.trim() ?? "").replace(/[\r\n\0]/g, "").slice(0, 200);
  if (ownerName) updates.OWNER_NAME = ownerName;
  if (ownerEmail) updates.OWNER_EMAIL = ownerEmail;

  // Resolve effective base URLs (Ollama in-stack override)
  const effectiveConnections = resolveOllamaUrls(input.connections, input.ollamaEnabled);

  // Build connectionId -> envVarName map
  const connEnvVarMap = buildConnectionEnvVarMap(effectiveConnections);

  // Write API keys
  for (const conn of effectiveConnections) {
    if (!conn.apiKey) continue;
    const envVar = connEnvVarMap.get(conn.id);
    if (envVar) updates[envVar] = conn.apiKey;
  }

  // System LLM vars
  const llmConnection = effectiveConnections.find((c) => c.id === input.assignments.llm.connectionId);
  if (llmConnection) {
    updates.SYSTEM_LLM_PROVIDER = llmConnection.provider;
    updates.SYSTEM_LLM_MODEL = input.assignments.llm.model;
    if (llmConnection.baseUrl) {
      updates.SYSTEM_LLM_BASE_URL = llmConnection.baseUrl;
      const normalizedUrl = llmConnection.baseUrl.replace(/\/+$/, "");
      updates.OPENAI_BASE_URL = normalizedUrl.endsWith("/v1") ? normalizedUrl : `${normalizedUrl}/v1`;
    }
  }

  // Memory user ID
  updates.MEMORY_USER_ID = input.memoryUserId || "default_user";

  return updates;
}

// ── Connection Env Var Map Builder ───────────────────────────────────────

/**
 * Build a Map<connectionId, envVarName> from connections, using PROVIDER_KEY_MAP
 * for the canonical mapping and falling back to namespaced vars for duplicates.
 */
export function buildConnectionEnvVarMap(
  connections: SetupConnection[]
): Map<string, string> {
  const connEnvVarMap = new Map<string, string>();
  const claimedEnvVars = new Set<string>();

  for (const conn of connections) {
    let envVarName = PROVIDER_KEY_MAP[conn.provider] ?? "OPENAI_API_KEY";
    if (claimedEnvVars.has(envVarName)) {
      envVarName = `${envVarName}_${conn.id}`;
    }
    const upperKey = envVarName.toUpperCase();
    if (!SAFE_ENV_KEY_RE.test(upperKey)) {
      logger.warn("skipping connection with unsafe env var key", { connectionId: conn.id, envVarName });
      continue;
    }
    claimedEnvVars.add(upperKey);
    connEnvVarMap.set(conn.id, upperKey);
  }

  return connEnvVarMap;
}

// ── Core Setup Orchestration ─────────────────────────────────────────────

/**
 * Core setup orchestration -- shared by CLI and admin.
 *
 * Steps:
 * 1. Validate input fields
 * 2. Build connection env var map
 * 3. Update secrets.env with API keys and system config
 * 4. Build and write memory config via buildMem0Mapping()
 * 5. Write connection profiles
 * 6. Ensure OpenCode configs
 * 7. Apply install via applyInstall()
 *
 * Does NOT include Docker operations (compose up, pull, etc.) — the caller
 * handles those separately after setup completes.
 */
export async function performSetup(
  input: SetupInput,
  assetProvider: CoreAssetProvider,
  opts?: { state?: ControlPlaneState }
): Promise<SetupResult> {
  // ── Validate ─────────────────────────────────────────────────────────
  const validation = validateSetupInput(input);
  if (!validation.valid) {
    return { ok: false, error: validation.errors.join("; ") };
  }

  logger.info("performing setup", {
    connectionCount: input.connections.length,
    ollamaEnabled: input.ollamaEnabled,
  });

  // ── Resolve state ────────────────────────────────────────────────────
  const state = opts?.state ?? createState(input.adminToken);

  // ── Resolve effective connections (Ollama in-stack override) ──────────
  const effectiveConnections = resolveOllamaUrls(input.connections, input.ollamaEnabled);

  // ── Build connection env var map ─────────────────────────────────────
  const connEnvVarMap = buildConnectionEnvVarMap(effectiveConnections);

  // ── Build secrets.env updates ────────────────────────────────────────
  const updates = buildSecretsFromSetup(input);

  // ── Persist secrets.env ──────────────────────────────────────────────
  try {
    ensureXdgDirs();
    ensureSecrets(state);
    ensureConnectionProfilesStore(state.configDir);
    updateSecretsEnv(state, updates);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("failed to update secrets.env", { error: message });
    return { ok: false, error: `Failed to update secrets.env: ${message}` };
  }

  // Update state with new admin token
  state.adminToken = input.adminToken;
  writeSetupTokenFile(state);

  // ── Build and persist Memory config ──────────────────────────────────
  const llmConnectionId = input.assignments.llm.connectionId;
  const embConnectionId = input.assignments.embeddings.connectionId;
  const llmModel = input.assignments.llm.model;
  const llmSmallModel = input.assignments.llm.smallModel || "";
  const embModel = input.assignments.embeddings.model;
  const embDims = input.assignments.embeddings.embeddingDims || 0;

  const llmConnection = effectiveConnections.find((c) => c.id === llmConnectionId);
  if (!llmConnection) {
    return { ok: false, error: `LLM connection "${llmConnectionId}" not found in connections list` };
  }
  const embConnection = effectiveConnections.find((c) => c.id === embConnectionId);
  if (!embConnection) {
    return { ok: false, error: `Embeddings connection "${embConnectionId}" not found in connections list` };
  }

  const memoryModel = llmSmallModel || llmModel;

  const llmEnvVar = connEnvVarMap.get(llmConnection.id);
  if (!llmEnvVar) {
    return { ok: false, error: `No env var mapping found for LLM connection "${llmConnection.id}"` };
  }
  const llmApiKeyEnvRef = llmConnection.apiKey ? `env:${llmEnvVar}` : "not-needed";

  const embEnvVar = connEnvVarMap.get(embConnection.id);
  if (!embEnvVar) {
    return { ok: false, error: `No env var mapping found for embeddings connection "${embConnection.id}"` };
  }
  const embApiKeyEnvRef = embConnection.apiKey ? `env:${embEnvVar}` : "not-needed";

  const embLookupKey = `${embConnection.provider}/${embModel}`;
  const resolvedDims = embDims || EMBEDDING_DIMS[embLookupKey] || 1536;

  const omConfig = buildMem0Mapping({
    llm: {
      provider: llmConnection.provider,
      baseUrl: llmConnection.baseUrl,
      model: memoryModel,
      apiKeyRef: llmApiKeyEnvRef,
    },
    embedder: {
      provider: embConnection.provider,
      baseUrl: embConnection.baseUrl,
      model: embModel || "text-embedding-3-small",
      apiKeyRef: embApiKeyEnvRef,
    },
    embeddingDims: resolvedDims,
    customInstructions: "",
  });

  writeMemoryConfig(state.dataDir, omConfig);

  // ── Write connection profiles ────────────────────────────────────────
  const profilesInput = effectiveConnections.map((conn) => ({
    id: conn.id,
    name: conn.name,
    provider: conn.provider,
    baseUrl: conn.baseUrl,
    hasApiKey: Boolean(conn.apiKey),
    apiKeyEnvVar: connEnvVarMap.get(conn.id)!,
  }));

  writeConnectionsDocument(state.configDir, {
    profiles: profilesInput,
    assignments: {
      llm: input.assignments.llm,
      embeddings: {
        connectionId: input.assignments.embeddings.connectionId,
        model: input.assignments.embeddings.model,
        embeddingDims: resolvedDims,
      },
    } as CapabilityAssignments,
  });

  // ── Ensure OpenCode configs ──────────────────────────────────────────
  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig(assetProvider);
  ensureAdminOpenCodeConfig(assetProvider);
  ensureMemoryDir();

  // ── Write stack spec (openpalm.yaml) ─────────────────────────────────
  const stackSpec: StackSpec = {
    version: 3,
    connections: effectiveConnections.map((c) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      baseUrl: c.baseUrl,
    })),
    assignments: {
      llm: input.assignments.llm,
      embeddings: {
        connectionId: input.assignments.embeddings.connectionId,
        model: input.assignments.embeddings.model,
        embeddingDims: resolvedDims,
      },
    },
    ollamaEnabled: input.ollamaEnabled,
  };
  writeStackSpec(state.configDir, stackSpec);

  // ── Mark setup complete in DATA_HOME stack.env before staging ────────
  const dataStackEnv = `${state.dataDir}/stack.env`;
  mkdirSync(state.dataDir, { recursive: true });
  const stackBase = existsSync(dataStackEnv) ? readFileSync(dataStackEnv, "utf-8") : "";
  writeFileSync(
    dataStackEnv,
    mergeEnvContent(stackBase, { OPENPALM_SETUP_COMPLETE: "true" })
  );

  // ── Apply install (stages artifacts, no Docker) ──────────────────────
  applyInstall(state, assetProvider);

  logger.info("setup complete", {
    connectionCount: input.connections.length,
    llmProvider: llmConnection.provider,
    llmModel,
    embModel,
  });

  return { ok: true };
}

// ── Provider Detection ───────────────────────────────────────────────────

/**
 * Detect available local providers in a setup-friendly format.
 * Wraps detectLocalProviders() from model-runner.ts.
 */
export async function detectProviders(): Promise<DetectedProvider[]> {
  const raw = await detectLocalProviders();
  return raw.map((r: LocalProviderDetection) => ({
    provider: r.provider,
    url: r.url,
    available: r.available,
  }));
}
