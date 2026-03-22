/**
 * Shared setup orchestration for the OpenPalm control plane.
 *
 * Extracts the reusable core logic from the admin's POST /admin/setup handler
 * so that both the CLI setup wizard and the admin UI can call `performSetup()`.
 *
 * This module does NOT include Docker operations (compose up, image pull, etc.)
 * — those happen separately in the caller after setup completes.
 *
 * v2: SetupSpec is the single input type. StackSpec (stack.yaml content) is
 *     wrapped with setup-only transient fields (security, owner, connections,
 *     channel credentials).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createLogger } from "../logger.js";
import {
  LLM_PROVIDERS,
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
import { buildMem0Mapping } from "./connection-mapping.js";
import { writeMemoryConfig } from "./memory-config.js";
import { ensureOpenCodeSystemConfig, ensureMemoryDir } from "./core-assets.js";
import { applyInstall, createState, writeSetupTokenFile } from "./lifecycle.js";
import { writeStackSpec, parseCapabilityString, hasAddon } from "./stack-spec.js";
import type { StackSpec } from "./stack-spec.js";
import { writeManagedEnvFiles } from "./spec-to-env.js";
import type { ControlPlaneState } from "./types.js";

const logger = createLogger("setup");

// ── Types ────────────────────────────────────────────────────────────────

export type SetupConnection = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
};

export type SetupResult = {
  ok: boolean;
  error?: string;
  /** Services that should be started after setup. */
  started?: string[];
};

/**
 * Input to performSetup — StackSpec plus transient setup-only fields.
 *
 * The `spec` is the stack.yaml content that gets written to config/.
 * Everything else (security, owner, connections, channelCredentials) is
 * transient data that gets written to vault/ or used during setup only.
 */
export type SetupSpec = {
  /** The stack.yaml content (written to config/) */
  spec: StackSpec;
  /** Setup-only fields (not persisted in stack.yaml) */
  security: { adminToken: string };
  owner?: { name?: string; email?: string };
  /** Provider connections with API keys (written to vault/) */
  connections: SetupConnection[];
  /** Channel credentials (written to vault/) */
  channelCredentials?: Record<string, Record<string, string>>;
};

// ── Validation ───────────────────────────────────────────────────────────

/** Safe env var key pattern: uppercase alphanumeric + underscores, starting with a letter. */
const SAFE_ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/** Valid connection ID pattern: starts with letter or digit, allows A-Z, a-z, 0-9, _, -. */
const CONNECTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Accepted provider names for setup connections.
 * Derived from LLM_PROVIDERS plus the internal "ollama-instack" alias.
 */
const ACCEPTED_PROVIDERS = new Set([
  ...LLM_PROVIDERS,
  "ollama-instack",
]);

/**
 * Validate a SetupSpec input.
 * Returns validation result with errors array.
 */
export function validateSetupSpec(input: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof input !== "object" || input === null) {
    return { valid: false, errors: ["Input must be a non-null object"] };
  }

  const body = input as Record<string, unknown>;

  // ── security ─────────────────────────────────────────────────────────
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

  // ── owner (optional) ────────────────────────────────────────────────
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

  // ── connections ─────────────────────────────────────────────────────
  validateConnectionsArray(body.connections, errors);

  // ── spec (StackSpec) ────────────────────────────────────────────────
  if (typeof body.spec !== "object" || body.spec === null) {
    errors.push("spec object is required");
  } else {
    const spec = body.spec as Record<string, unknown>;
    if (spec.version !== 2) {
      errors.push("spec.version must be 2");
    }
    if (typeof spec.capabilities !== "object" || spec.capabilities === null) {
      errors.push("spec.capabilities is required");
    } else {
      const caps = spec.capabilities as Record<string, unknown>;
      if (typeof caps.llm !== "string" || !caps.llm) {
        errors.push("spec.capabilities.llm is required (format: 'provider/model')");
      }
      if (typeof caps.embeddings !== "object" || caps.embeddings === null) {
        errors.push("spec.capabilities.embeddings is required");
      } else {
        const emb = caps.embeddings as Record<string, unknown>;
        if (typeof emb.provider !== "string" || !emb.provider) {
          errors.push("spec.capabilities.embeddings.provider is required");
        }
        if (typeof emb.model !== "string" || !emb.model) {
          errors.push("spec.capabilities.embeddings.model is required");
        }
        if (emb.dims !== undefined && emb.dims !== 0 && (typeof emb.dims !== "number" || !Number.isInteger(emb.dims) || emb.dims < 1)) {
          errors.push("spec.capabilities.embeddings.dims must be a positive integer or 0 (auto-resolve)");
        }
      }
      if (typeof caps.memory !== "object" || caps.memory === null) {
        errors.push("spec.capabilities.memory is required");
      } else {
        const mem = caps.memory as Record<string, unknown>;
        if (mem.userId !== undefined && typeof mem.userId !== "string") {
          errors.push("spec.capabilities.memory.userId must be a string if provided");
        }
        if (typeof mem.userId === "string" && mem.userId && !/^[A-Za-z0-9_]+$/.test(mem.userId)) {
          errors.push("spec.capabilities.memory.userId contains invalid characters (alphanumeric and underscores only)");
        }
      }
    }
  }

  // ── channelCredentials (optional) ──────────────────────────────────
  if (body.channelCredentials !== undefined) {
    if (typeof body.channelCredentials !== "object" || body.channelCredentials === null) {
      errors.push("channelCredentials must be an object if provided");
    }
  }

  return { valid: errors.length === 0, errors };
}

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
    } else if (!ACCEPTED_PROVIDERS.has(provider)) {
      errors.push(`connections[${i}].provider "${provider}" is outside wizard scope`);
    }
  }
}

// ── Secrets Builder ──────────────────────────────────────────────────────

/**
 * Build the env var map from connections.
 * Only writes actual secrets (API keys) and owner info to user.env.
 */
export function buildSecretsFromSetup(
  connections: SetupConnection[],
  owner?: { name?: string; email?: string },
): Record<string, string> {
  const updates: Record<string, string> = {};

  // Owner info
  const ownerName = (owner?.name?.trim() ?? "").replace(/[\r\n\0]/g, "").slice(0, 200);
  const ownerEmail = (owner?.email?.trim() ?? "").replace(/[\r\n\0]/g, "").slice(0, 200);
  if (ownerName) updates.OWNER_NAME = ownerName;
  if (ownerEmail) updates.OWNER_EMAIL = ownerEmail;

  // Build connectionId -> envVarName map
  const connEnvVarMap = buildConnectionEnvVarMap(connections);

  // Write API keys only
  for (const conn of connections) {
    if (!conn.apiKey) continue;
    const envVar = connEnvVarMap.get(conn.id);
    if (envVar) updates[envVar] = conn.apiKey;
  }

  return updates;
}

export function buildSystemSecretsFromSetup(
  adminToken: string,
  existingSystemEnv: Record<string, string> = {}
): Record<string, string> {
  return {
    OP_ADMIN_TOKEN: adminToken,
    OP_ASSISTANT_TOKEN: existingSystemEnv.OP_ASSISTANT_TOKEN || randomBytes(32).toString("hex"),
    OP_MEMORY_TOKEN: existingSystemEnv.OP_MEMORY_TOKEN || randomBytes(32).toString("hex"),
  };
}

// ── Connection Env Var Map Builder ───────────────────────────────────────

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

// ── Ollama URL Resolution ────────────────────────────────────────────────

/** Apply Ollama in-stack URL override to connections when Ollama addon is enabled. */
function resolveOllamaUrls(connections: SetupConnection[], ollamaEnabled: boolean): SetupConnection[] {
  if (!ollamaEnabled) return connections;
  return connections.map((c) =>
    c.provider === "ollama" ? { ...c, baseUrl: OLLAMA_INSTACK_URL } : c
  );
}

// ── Core Setup Orchestration ─────────────────────────────────────────────

/**
 * Core setup orchestration -- shared by CLI and admin.
 *
 * Accepts a SetupSpec which wraps a StackSpec with transient setup fields.
 *
 * Steps:
 * 1. Validate input fields
 * 2. Write secrets (API keys, owner info) to vault/user/user.env
 * 3. Write channel credentials to vault/user/user.env
 * 4. Write stack.yaml v2 from spec
 * 5. Write managed.env files derived from capabilities
 * 6. Build and write memory config
 * 7. Ensure OpenCode configs
 * 8. Apply install via applyInstall()
 */
export async function performSetup(
  input: SetupSpec,
  opts?: { state?: ControlPlaneState }
): Promise<SetupResult> {
  const validation = validateSetupSpec(input);
  if (!validation.valid) {
    return { ok: false, error: validation.errors.join("; ") };
  }

  const { spec, security, owner, connections, channelCredentials } = input;
  const ollamaEnabled = hasAddon(spec, "ollama");

  logger.info("performing setup", {
    connectionCount: connections.length,
    ollamaEnabled,
  });

  const state = opts?.state ?? createState(security.adminToken);
  const effectiveConnections = resolveOllamaUrls(connections, ollamaEnabled);
  const connEnvVarMap = buildConnectionEnvVarMap(effectiveConnections);

  // Build secrets (API keys + owner info only)
  const updates = buildSecretsFromSetup(effectiveConnections, owner);

  // ── Persist vault env files ──────────────────────────────────────────
  try {
    ensureHomeDirs();
    ensureSecrets(state);
    const existingSystemEnv = readSystemSecretsEnvFile(state.vaultDir);

    // Write channel credentials to user.env
    if (channelCredentials) {
      const channelEnvVars = buildChannelCredentialEnvVarsFromMap(channelCredentials);
      if (Object.keys(channelEnvVars).length > 0) {
        Object.assign(updates, channelEnvVars);
      }
    }

    updateSecretsEnv(state, updates);
    updateSystemSecretsEnv(state, buildSystemSecretsFromSetup(security.adminToken, existingSystemEnv));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("failed to update vault env files", { error: message });
    return { ok: false, error: `Failed to update vault env files: ${message}` };
  }

  state.adminToken = security.adminToken;
  state.assistantToken = readSystemSecretsEnvFile(state.vaultDir).OP_ASSISTANT_TOKEN ?? state.assistantToken;
  writeSetupTokenFile(state);

  // ── Resolve connection details from capabilities ────────────────────
  const { provider: llmProvider, model: llmModel } = parseCapabilityString(spec.capabilities.llm);
  const slmCap = spec.capabilities.slm ? parseCapabilityString(spec.capabilities.slm) : null;
  const embProvider = spec.capabilities.embeddings.provider;
  const embModel = spec.capabilities.embeddings.model;
  const embDims = spec.capabilities.embeddings.dims;

  // Find matching connections by provider
  const llmConnection = effectiveConnections.find((c) => c.provider === llmProvider);
  if (!llmConnection) {
    return { ok: false, error: `No connection found for LLM provider "${llmProvider}"` };
  }
  const embConnection = effectiveConnections.find((c) => c.provider === embProvider);
  if (!embConnection) {
    return { ok: false, error: `No connection found for embeddings provider "${embProvider}"` };
  }

  // Resolve embedding dims from lookup if not explicitly provided
  const embLookupKey = `${embProvider}/${embModel}`;
  const resolvedDims = embDims || EMBEDDING_DIMS[embLookupKey] || 1536;

  // Ensure dims are set in the spec before writing
  const specToWrite: StackSpec = {
    ...spec,
    capabilities: {
      ...spec.capabilities,
      embeddings: {
        ...spec.capabilities.embeddings,
        dims: resolvedDims,
      },
    },
  };

  // ── Write stack.yaml v2 ─────────────────────────────────────────────
  writeStackSpec(state.configDir, specToWrite);

  // ── Write managed.env files ─────────────────────────────────────────
  writeManagedEnvFiles(specToWrite, state.vaultDir);

  // ── Build and persist Memory config ─────────────────────────────────
  const memoryModel = slmCap ? slmCap.model : llmModel;

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
    customInstructions: spec.capabilities.memory.customInstructions || "",
  });

  writeMemoryConfig(state.dataDir, omConfig);

  // ── Ensure OpenCode configs ────────────────────────────────────────
  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig();
  ensureMemoryDir();

  // ── Mark setup complete in DATA_HOME stack.env before persistence ──
  const dataStackEnv = `${state.dataDir}/stack.env`;
  mkdirSync(state.dataDir, { recursive: true });
  const stackBase = existsSync(dataStackEnv) ? readFileSync(dataStackEnv, "utf-8") : "";
  writeFileSync(
    dataStackEnv,
    mergeEnvContent(stackBase, {
      OP_SETUP_COMPLETE: "true",
    })
  );

  // ── Apply install (stages artifacts, no Docker) ────────────────────
  await applyInstall(state);

  logger.info("setup complete", {
    connectionCount: connections.length,
    llmProvider,
    llmModel,
    embModel,
  });

  return { ok: true };
}

// ── Channel Credential Env Var Mapping ───────────────────────────────────

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

/**
 * Build env vars from a channelCredentials map (new SetupSpec format).
 * channelCredentials is Record<channelName, Record<credKey, credValue>>.
 */
export function buildChannelCredentialEnvVarsFromMap(
  channelCredentials: Record<string, Record<string, string>>
): Record<string, string> {
  const envVars: Record<string, string> = {};

  for (const [channelId, creds] of Object.entries(channelCredentials)) {
    const mapping = CHANNEL_CREDENTIAL_ENV_MAP[channelId];
    if (!mapping) continue;

    for (const [field, envKey] of Object.entries(mapping)) {
      const fieldValue = creds[field];
      if (fieldValue === undefined || fieldValue === null) continue;
      if (typeof fieldValue === "string" && fieldValue) {
        envVars[envKey] = fieldValue;
      }
    }
  }

  return envVars;
}

/**
 * Build env vars from the legacy ChannelCredentials format.
 * Kept for backward compatibility with buildChannelCredentialEnvVars callers.
 */
export function buildChannelCredentialEnvVars(
  channels: Record<string, boolean | Record<string, unknown>> | undefined
): Record<string, string> {
  const envVars: Record<string, string> = {};
  if (!channels) return envVars;

  for (const [channelId, value] of Object.entries(channels)) {
    if (typeof value === "boolean") continue;
    if (typeof value !== "object" || value === null) continue;

    const mapping = CHANNEL_CREDENTIAL_ENV_MAP[channelId];
    if (!mapping) continue;

    const creds = value as Record<string, unknown>;
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
