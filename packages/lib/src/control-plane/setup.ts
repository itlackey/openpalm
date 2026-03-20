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
import { randomBytes } from "node:crypto";
import { createLogger } from "../logger.js";
import {
  PROVIDER_KEY_MAP,
  EMBEDDING_DIMS,
  OLLAMA_INSTACK_URL,
} from "../provider-constants.js";
import { mergeEnvContent } from "./env.js";
import { ensureHomeDirs } from "./home.js";
import {
  ensureSecrets,
  updateSecretsEnv,
  updateSystemSecretsEnv,
  ensureOpenCodeConfig,
  readSystemSecretsEnvFile,
} from "./secrets.js";
import { ensureConnectionProfilesStore, writeConnectionsDocument } from "./connection-profiles.js";
import { buildMem0Mapping } from "./connection-mapping.js";
import { writeMemoryConfig } from "./memory-config.js";
import { ensureOpenCodeSystemConfig, ensureAdminOpenCodeConfig, ensureMemoryDir } from "./core-assets.js";
import { applyInstall, createState, writeSetupTokenFile } from "./lifecycle.js";
import { writeStackSpecV3 } from "./stack-spec.js";
import type { StackSpecV3 } from "./stack-spec.js";
import { detectLocalProviders } from "./model-runner.js";
import type { LocalProviderDetection } from "./model-runner.js";
import type { CoreAssetProvider } from "./core-asset-provider.js";
import type { ControlPlaneState, CapabilityAssignments, TtsAssignment, SttAssignment } from "./types.js";

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
  voice?: {
    tts?: string;  // e.g. 'kokoro', 'piper', 'openai-tts', 'browser-tts', null
    stt?: string;  // e.g. 'whisper-local', 'openai-stt', 'browser-stt', null
  };
  channels?: string[];  // e.g. ['chat', 'discord', 'api']
  services?: {
    admin?: boolean;
    openviking?: boolean;
    ollama?: boolean;
  };
};

export type SetupResult = {
  ok: boolean;
  error?: string;
  /** Services that should be started after setup. */
  started?: string[];
};

// ── SetupConfig (structured 7-section format) ────────────────────────────

export type SetupConfig = {
  version: 1;
  owner?: { name?: string; email?: string };
  security: { adminToken: string };
  connections: SetupConnection[];
  assignments: SetupConfigAssignments;
  memory?: { userId?: string };
  channels?: Record<string, boolean | ChannelCredentials>;
  services?: Record<string, boolean | ServiceConfig>;
};

export type SetupConfigAssignments = {
  llm: { connectionId: string; model: string; smallModel?: string };
  embeddings: { connectionId: string; model: string; embeddingDims?: number };
  tts?: { engine: string; connectionId?: string; model?: string } | string | null;
  stt?: { engine: string; connectionId?: string; model?: string } | string | null;
};

export type ChannelCredentials = {
  enabled?: boolean;
  botToken?: string;
  applicationId?: string;
  registerCommands?: boolean;
  allowedGuilds?: string;
  allowedRoles?: string;
  allowedUsers?: string;
  blockedUsers?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  allowedChannels?: string;
  [key: string]: unknown;
};

export type ServiceConfig = {
  enabled: boolean;
  [key: string]: unknown;
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
  "ollama-instack", "google", "huggingface",
]);

// ── Shared Validation Helpers ────────────────────────────────────────────

/** Validate a connections array. Pushes errors to the provided array. */
function validateConnectionsArray(
  connections: unknown,
  errors: string[]
): void {
  if (!Array.isArray(connections) || connections.length === 0) {
    errors.push("connections array is required and must be non-empty");
    return;
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < connections.length; i++) {
    const c = connections[i];
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

/**
 * Validate assignments block (llm + embeddings) and cross-validate
 * connectionIds against the connections array. Pushes errors to the
 * provided array.
 */
function validateAssignmentsBlock(
  assignments: unknown,
  connections: unknown,
  errors: string[]
): void {
  if (typeof assignments !== "object" || assignments === null) {
    errors.push("assignments object is required");
    return;
  }

  const assignmentsObj = assignments as Record<string, unknown>;
  const llm = assignmentsObj.llm;
  const embeddings = assignmentsObj.embeddings;
  const preAssignmentLength = errors.length;

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

  // Cross-validate: assignment connectionIds must reference a connection.
  // Only run when no new assignment errors were added above.
  if (Array.isArray(connections) && errors.length === preAssignmentLength) {
    const connectionIds = new Set(
      (connections as Array<Record<string, unknown>>).map(
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
  if (typeof body.memoryUserId === "string" && !/^[A-Za-z0-9_]+$/.test(body.memoryUserId)) {
    errors.push("memoryUserId contains invalid characters (alphanumeric and underscores only)");
  }

  // ollamaEnabled
  if (body.ollamaEnabled !== undefined && typeof body.ollamaEnabled !== "boolean") {
    errors.push("ollamaEnabled must be a boolean");
  }

  // voice (optional)
  if (body.voice !== undefined) {
    if (typeof body.voice !== "object" || body.voice === null) {
      errors.push("voice must be an object if provided");
    } else {
      const voice = body.voice as Record<string, unknown>;
      if (voice.tts !== undefined && voice.tts !== null && typeof voice.tts !== "string") {
        errors.push("voice.tts must be a string or null if provided");
      }
      if (voice.stt !== undefined && voice.stt !== null && typeof voice.stt !== "string") {
        errors.push("voice.stt must be a string or null if provided");
      }
    }
  }

  // channels (optional)
  if (body.channels !== undefined) {
    if (!Array.isArray(body.channels)) {
      errors.push("channels must be an array if provided");
    } else {
      for (let i = 0; i < body.channels.length; i++) {
        if (typeof body.channels[i] !== "string") {
          errors.push(`channels[${i}] must be a string`);
        }
      }
    }
  }

  // services (optional)
  if (body.services !== undefined) {
    if (typeof body.services !== "object" || body.services === null) {
      errors.push("services must be an object if provided");
    } else {
      const services = body.services as Record<string, unknown>;
      for (const [key, val] of Object.entries(services)) {
        if (typeof val !== "boolean") {
          errors.push(`services.${key} must be a boolean`);
        }
      }
    }
  }

  // connections
  validateConnectionsArray(body.connections, errors);

  // assignments
  validateAssignmentsBlock(body.assignments, body.connections, errors);

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

  // Voice: TTS/STT env vars based on engine choice
  if (input.voice) {
    // Find an OpenAI-compatible connection for cloud engines.
    // Normalize base URL: strip trailing slashes and /v1 suffix since
    // the voice channel providers append /v1/... themselves.
    const openaiConn = effectiveConnections.find((c) => c.provider === "openai");
    const openaiBaseUrl = (openaiConn?.baseUrl || "https://api.openai.com")
      .replace(/\/+$/, "")
      .replace(/\/v1$/, "");
    const openaiKey = openaiConn?.apiKey || "";

    const { tts, stt } = input.voice;

    if (stt === "openai-stt") {
      updates.STT_BASE_URL = openaiBaseUrl;
      updates.STT_API_KEY = openaiKey;
      updates.STT_MODEL = "whisper-1";
    } else if (stt === "whisper-local") {
      updates.STT_BASE_URL = "http://whisper:9000";
      updates.STT_MODEL = "whisper-1";
    }
    // browser-stt / skip-stt: no env vars needed (voice channel falls back to browser)

    if (tts === "openai-tts") {
      updates.TTS_BASE_URL = openaiBaseUrl;
      updates.TTS_API_KEY = openaiKey;
      updates.TTS_MODEL = "tts-1";
      updates.TTS_VOICE = "alloy";
    } else if (tts === "kokoro") {
      updates.TTS_BASE_URL = "http://kokoro:8880";
      updates.TTS_MODEL = "kokoro";
    } else if (tts === "piper") {
      updates.TTS_BASE_URL = "http://piper:5000";
      updates.TTS_MODEL = "piper";
    }
    // browser-tts / skip-tts: no env vars needed (voice channel falls back to browser)
  }

  return updates;
}

export function buildSystemSecretsFromSetup(
  input: SetupInput,
  existingSystemEnv: Record<string, string> = {}
): Record<string, string> {
  return {
    OPENPALM_ADMIN_TOKEN: input.adminToken,
    ASSISTANT_TOKEN: existingSystemEnv.ASSISTANT_TOKEN || randomBytes(32).toString("hex"),
    MEMORY_AUTH_TOKEN: existingSystemEnv.MEMORY_AUTH_TOKEN || randomBytes(32).toString("hex"),
  };
}

// ── Voice Assignment Builder ──────────────────────────────────────────────

const PROVIDER_TTS_ENGINES = new Set(["openai-tts"]);
const PROVIDER_STT_ENGINES = new Set(["openai-stt"]);

const TTS_ENGINE_DEFAULTS: Record<string, { model: string; voice?: string }> = {
  "openai-tts": { model: "tts-1", voice: "alloy" },
  "kokoro": { model: "kokoro" },
  "piper": { model: "piper" },
  "browser-tts": { model: "browser" },
};

const STT_ENGINE_DEFAULTS: Record<string, { model: string }> = {
  "openai-stt": { model: "whisper-1" },
  "whisper-local": { model: "whisper-1" },
  "browser-stt": { model: "browser" },
};

function buildTtsAssignment(
  engine: string,
  connections: SetupConnection[]
): TtsAssignment | undefined {
  const defaults = TTS_ENGINE_DEFAULTS[engine];
  if (!defaults) return undefined;

  const assignment: TtsAssignment = { enabled: true, model: defaults.model };
  if (defaults.voice) assignment.voice = defaults.voice;

  if (PROVIDER_TTS_ENGINES.has(engine)) {
    const openaiConn = connections.find((c) => c.provider === "openai");
    if (openaiConn) assignment.connectionId = openaiConn.id;
  }

  return assignment;
}

function buildSttAssignment(
  engine: string,
  connections: SetupConnection[]
): SttAssignment | undefined {
  const defaults = STT_ENGINE_DEFAULTS[engine];
  if (!defaults) return undefined;

  const assignment: SttAssignment = { enabled: true, model: defaults.model };

  if (PROVIDER_STT_ENGINES.has(engine)) {
    const openaiConn = connections.find((c) => c.provider === "openai");
    if (openaiConn) assignment.connectionId = openaiConn.id;
  }

  return assignment;
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
  // Pass already-resolved connections to avoid a second resolveOllamaUrls call
  const updates = buildSecretsFromSetup({ ...input, connections: effectiveConnections });

  // ── Persist vault env files ──────────────────────────────────────────
  try {
    ensureHomeDirs();
    ensureSecrets(state);
    ensureConnectionProfilesStore(state.configDir);
    const existingSystemEnv = readSystemSecretsEnvFile(state.vaultDir);
    updateSecretsEnv(state, updates);
    updateSystemSecretsEnv(state, buildSystemSecretsFromSetup(input, existingSystemEnv));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("failed to update vault env files", { error: message });
    return { ok: false, error: `Failed to update vault env files: ${message}` };
  }

  // Update state with new admin token
  state.adminToken = input.adminToken;
  state.assistantToken = readSystemSecretsEnvFile(state.vaultDir).ASSISTANT_TOKEN ?? state.assistantToken;
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
  const profilesInput = effectiveConnections.map((conn) => {
    const apiKeyEnvVar = connEnvVarMap.get(conn.id);
    return {
      id: conn.id,
      name: conn.name,
      provider: conn.provider,
      baseUrl: conn.baseUrl,
      hasApiKey: Boolean(conn.apiKey) && Boolean(apiKeyEnvVar),
      apiKeyEnvVar: apiKeyEnvVar ?? "",
    };
  });

  const ttsAssignment = input.voice?.tts
    ? buildTtsAssignment(input.voice.tts, effectiveConnections)
    : undefined;
  const sttAssignment = input.voice?.stt
    ? buildSttAssignment(input.voice.stt, effectiveConnections)
    : undefined;

  const voiceAssignments: Pick<CapabilityAssignments, 'tts' | 'stt'> = {};
  if (ttsAssignment) voiceAssignments.tts = ttsAssignment;
  if (sttAssignment) voiceAssignments.stt = sttAssignment;

  writeConnectionsDocument(state.configDir, {
    profiles: profilesInput,
    assignments: {
      llm: input.assignments.llm,
      embeddings: {
        connectionId: input.assignments.embeddings.connectionId,
        model: input.assignments.embeddings.model,
        embeddingDims: resolvedDims,
      },
      ...voiceAssignments,
    },
  });

  // ── Ensure OpenCode configs ──────────────────────────────────────────
  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig(assetProvider);
  ensureAdminOpenCodeConfig(assetProvider);
  ensureMemoryDir();

  // ── Write stack spec (openpalm.yaml) ─────────────────────────────────
  // Still writes v3 format — the migration to v4 happens via migrateV3ToV4()
  // or transparently via readStackSpec() which auto-upgrades v3→v4 on read.
  const stackSpec: StackSpecV3 = {
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
    ...(input.voice ? { voice: input.voice } : {}),
    ...(input.channels ? { channels: input.channels } : {}),
    ...(input.services ? { services: input.services } : {}),
  };
  writeStackSpecV3(state.configDir, stackSpec);

  // ── Mark setup complete in DATA_HOME stack.env before staging ────────
  const dataStackEnv = `${state.dataDir}/stack.env`;
  mkdirSync(state.dataDir, { recursive: true });
  const stackBase = existsSync(dataStackEnv) ? readFileSync(dataStackEnv, "utf-8") : "";
  writeFileSync(
    dataStackEnv,
    mergeEnvContent(stackBase, {
      OPENPALM_SETUP_COMPLETE: "true",
      OPENPALM_OLLAMA_ENABLED: input.ollamaEnabled ? "true" : "false",
      OPENPALM_ADMIN_ENABLED: input.services?.admin ? "true" : "false",
    })
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

// ── Channel Credential Env Var Mapping ───────────────────────────────────

/** Maps channel IDs to their credential field → env var name mappings. */
export const CHANNEL_CREDENTIAL_ENV_MAP: Record<string, Record<string, string>> = {
  discord: {
    botToken: "DISCORD_BOT_TOKEN",
    applicationId: "DISCORD_APPLICATION_ID",
    registerCommands: "DISCORD_REGISTER_COMMANDS",
    allowedGuilds: "DISCORD_ALLOWED_GUILDS",
    allowedRoles: "DISCORD_ALLOWED_ROLES",
    allowedUsers: "DISCORD_ALLOWED_USERS",
    blockedUsers: "DISCORD_BLOCKED_USERS",
  },
  slack: {
    slackBotToken: "SLACK_BOT_TOKEN",
    slackAppToken: "SLACK_APP_TOKEN",
    allowedChannels: "SLACK_ALLOWED_CHANNELS",
    allowedUsers: "SLACK_ALLOWED_USERS",
    blockedUsers: "SLACK_BLOCKED_USERS",
  },
};

// ── SetupConfig Validation ───────────────────────────────────────────────

/**
 * Validate a SetupConfig object. Returns { valid, errors } in the same
 * shape as validateSetupInput().
 */
export function validateSetupConfig(config: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof config !== "object" || config === null) {
    return { valid: false, errors: ["Config must be a non-null object"] };
  }

  const body = config as Record<string, unknown>;

  // version
  if (body.version !== 1) {
    errors.push("version must be 1");
  }

  // owner (optional)
  if (body.owner !== undefined) {
    if (typeof body.owner !== "object" || body.owner === null) {
      errors.push("owner must be an object if provided");
    } else {
      const owner = body.owner as Record<string, unknown>;
      if (owner.name !== undefined && typeof owner.name !== "string") {
        errors.push("owner.name must be a string if provided");
      }
      if (owner.email !== undefined && typeof owner.email !== "string") {
        errors.push("owner.email must be a string if provided");
      }
    }
  }

  // security
  if (typeof body.security !== "object" || body.security === null) {
    errors.push("security object is required");
  } else {
    const security = body.security as Record<string, unknown>;
    if (typeof security.adminToken !== "string" || !security.adminToken) {
      errors.push("security.adminToken is required and must be a non-empty string");
    } else if (security.adminToken.length < 8) {
      errors.push("security.adminToken must be at least 8 characters");
    }
  }

  // connections
  validateConnectionsArray(body.connections, errors);

  // assignments
  validateAssignmentsBlock(body.assignments, body.connections, errors);

  // channels (optional)
  if (body.channels !== undefined) {
    if (typeof body.channels !== "object" || body.channels === null) {
      errors.push("channels must be an object if provided");
    } else {
      const channels = body.channels as Record<string, unknown>;
      for (const [channelId, value] of Object.entries(channels)) {
        if (typeof value === "boolean") continue;
        if (typeof value !== "object" || value === null) {
          errors.push(`channels.${channelId} must be a boolean or object`);
          continue;
        }
        // Channel-specific credential validation
        if (channelId === "discord") {
          const creds = value as Record<string, unknown>;
          if (creds.enabled !== false && !creds.botToken) {
            errors.push("channels.discord.botToken is required when discord is enabled");
          }
        }
        if (channelId === "slack") {
          const creds = value as Record<string, unknown>;
          if (creds.enabled !== false) {
            if (!creds.slackBotToken) {
              errors.push("channels.slack.slackBotToken is required when slack is enabled");
            }
            if (!creds.slackAppToken) {
              errors.push("channels.slack.slackAppToken is required when slack is enabled");
            }
          }
        }
      }
    }
  }

  // services (optional)
  if (body.services !== undefined) {
    if (typeof body.services !== "object" || body.services === null) {
      errors.push("services must be an object if provided");
    } else {
      const services = body.services as Record<string, unknown>;
      for (const [key, val] of Object.entries(services)) {
        if (typeof val === "boolean") continue;
        if (typeof val !== "object" || val === null) {
          errors.push(`services.${key} must be a boolean or object`);
        } else if (typeof (val as Record<string, unknown>).enabled !== "boolean") {
          errors.push(`services.${key}.enabled must be a boolean`);
        }
      }
    }
  }

  // memory (optional)
  if (body.memory !== undefined) {
    if (typeof body.memory !== "object" || body.memory === null) {
      errors.push("memory must be an object if provided");
    } else {
      const memory = body.memory as Record<string, unknown>;
      if (memory.userId !== undefined && typeof memory.userId !== "string") {
        errors.push("memory.userId must be a string if provided");
      }
      if (typeof memory.userId === "string" && !/^[A-Za-z0-9_]+$/.test(memory.userId)) {
        errors.push("memoryUserId contains invalid characters (alphanumeric and underscores only)");
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Normalization ────────────────────────────────────────────────────────

/**
 * Convert a structured SetupConfig to the flat SetupInput format so that
 * the existing performSetup() pipeline works unchanged.
 */
export function normalizeToSetupInput(config: SetupConfig): SetupInput {
  // Resolve TTS/STT voice fields
  let tts: string | undefined;
  let stt: string | undefined;

  if (config.assignments.tts !== undefined && config.assignments.tts !== null) {
    // SetupInput.voice only carries engine strings; connectionId and model
    // from the object form are dropped during normalization. To preserve
    // them, the caller should write the original SetupConfig to
    // openpalm.yaml separately.
    tts = typeof config.assignments.tts === "string"
      ? config.assignments.tts
      : config.assignments.tts.engine;
  }

  if (config.assignments.stt !== undefined && config.assignments.stt !== null) {
    // Same as tts above — connectionId and model are dropped during
    // normalization and not written to the stack spec by performSetup().
    stt = typeof config.assignments.stt === "string"
      ? config.assignments.stt
      : config.assignments.stt.engine;
  }

  // Extract enabled channels
  const enabledChannels: string[] = [];
  if (config.channels) {
    for (const [id, value] of Object.entries(config.channels)) {
      if (value === true) {
        enabledChannels.push(id);
      } else if (typeof value === "object" && value !== null) {
        const creds = value as ChannelCredentials;
        if (creds.enabled !== false) {
          enabledChannels.push(id);
        }
      }
    }
  }

  // Extract enabled services
  const enabledServices: Record<string, boolean> = {};
  if (config.services) {
    for (const [id, value] of Object.entries(config.services)) {
      if (typeof value === "boolean") {
        enabledServices[id] = value;
      } else if (typeof value === "object" && value !== null) {
        enabledServices[id] = (value as ServiceConfig).enabled;
      }
    }
  }

  // Determine ollamaEnabled from services
  const ollamaEnabled = enabledServices.ollama ?? false;

  return {
    adminToken: config.security.adminToken,
    ownerName: config.owner?.name,
    ownerEmail: config.owner?.email,
    memoryUserId: config.memory?.userId || "default_user",
    ollamaEnabled,
    connections: config.connections,
    assignments: {
      llm: config.assignments.llm,
      embeddings: config.assignments.embeddings,
    },
    ...(tts !== undefined || stt !== undefined ? { voice: { tts, stt } } : {}),
    ...(enabledChannels.length > 0 ? { channels: enabledChannels } : {}),
    ...(Object.keys(enabledServices).length > 0 ? { services: enabledServices as SetupInput["services"] } : {}),
  };
}

// ── Channel Credential Env Var Builder ───────────────────────────────────

/**
 * Extract credential fields from typed channel configs using
 * CHANNEL_CREDENTIAL_ENV_MAP and return a Record<string, string> suitable
 * for writing to secrets.env.
 *
 * Unknown channels (not in CHANNEL_CREDENTIAL_ENV_MAP) are skipped.
 * Boolean values are converted to strings.
 */
export function buildChannelCredentialEnvVars(
  channels: Record<string, boolean | ChannelCredentials> | undefined
): Record<string, string> {
  const envVars: Record<string, string> = {};
  if (!channels) return envVars;

  for (const [channelId, value] of Object.entries(channels)) {
    if (typeof value === "boolean") continue;
    if (typeof value !== "object" || value === null) continue;

    const mapping = CHANNEL_CREDENTIAL_ENV_MAP[channelId];
    if (!mapping) continue;

    const creds = value as ChannelCredentials;
    for (const [field, envKey] of Object.entries(mapping)) {
      const fieldValue = creds[field];
      if (fieldValue === undefined || fieldValue === null) continue;
      if (typeof fieldValue === "boolean") {
        envVars[envKey] = String(fieldValue);
      } else if (typeof fieldValue === "string" && fieldValue) {
        envVars[envKey] = fieldValue;
      }
    }
  }

  return envVars;
}

// ── Structured Setup Orchestration ───────────────────────────────────────

/**
 * Setup from a structured SetupConfig:
 * 1. Validate the config
 * 2. Write channel credential env vars to CONFIG_HOME/secrets.env
 * 3. Normalize to SetupInput and call performSetup()
 *
 * Channel credentials are written BEFORE performSetup() so that when
 * performSetup() stages secrets.env from CONFIG_HOME to STATE_HOME
 * (via applyInstall), the staged copy already contains channel creds.
 */
export async function performSetupFromConfig(
  config: SetupConfig,
  assetProvider: CoreAssetProvider,
  opts?: { state?: ControlPlaneState }
): Promise<SetupResult> {
  // ── Validate ─────────────────────────────────────────────────────────
  const validation = validateSetupConfig(config);
  if (!validation.valid) {
    return { ok: false, error: validation.errors.join("; ") };
  }

  // ── Write channel credentials to CONFIG_HOME/secrets.env FIRST ─────
  // This must happen before performSetup() which stages secrets.env
  // from CONFIG_HOME to STATE_HOME via applyInstall().
  const input = normalizeToSetupInput(config);
  const state = opts?.state ?? createState(config.security.adminToken);
  const channelEnvVars = buildChannelCredentialEnvVars(config.channels);
  if (Object.keys(channelEnvVars).length > 0) {
    try {
      ensureHomeDirs();
      ensureSecrets(state);
      updateSecretsEnv(state, channelEnvVars);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("failed to write channel credentials to secrets.env", { error: message });
      return { ok: false, error: `Failed to write channel credentials: ${message}` };
    }
  }

  // ── Normalize and delegate to performSetup ─────────────────────────
  // performSetup() writes its own secrets (admin token, API keys, etc.)
  // and then stages the now-complete secrets.env to STATE_HOME.
  const result = await performSetup(input, assetProvider, { ...opts, state });
  return result;
}
