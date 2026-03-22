/**
 * Shared setup orchestration for the OpenPalm control plane.
 *
 * Both the CLI setup wizard and the admin UI call `performSetup()`.
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
import { ensureOpenCodeSystemConfig, ensureMemoryDir } from "./core-assets.js";
import { applyInstall, createState, writeSetupTokenFile } from "./lifecycle.js";
import { writeStackSpec, parseCapabilityString, hasAddon } from "./stack-spec.js";
import type { StackSpec } from "./stack-spec.js";
import { writeManagedEnvFiles } from "./spec-to-env.js";
import type { ControlPlaneState } from "./types.js";
import { validateSetupSpec } from "./setup-validation.js";
export { validateSetupSpec } from "./setup-validation.js";

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
  started?: string[];
};

export type SetupSpec = {
  spec: StackSpec;
  security: { adminToken: string };
  owner?: { name?: string; email?: string };
  connections: SetupConnection[];
  channelCredentials?: Record<string, Record<string, string>>;
};

const SAFE_ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

// ── Secrets Builder ──────────────────────────────────────────────────────

export function buildSecretsFromSetup(
  connections: SetupConnection[],
  owner?: { name?: string; email?: string },
): Record<string, string> {
  const updates: Record<string, string> = {};
  const ownerName = (owner?.name?.trim() ?? "").replace(/[\r\n\0]/g, "").slice(0, 200);
  const ownerEmail = (owner?.email?.trim() ?? "").replace(/[\r\n\0]/g, "").slice(0, 200);
  if (ownerName) updates.OWNER_NAME = ownerName;
  if (ownerEmail) updates.OWNER_EMAIL = ownerEmail;

  const connEnvVarMap = buildConnectionEnvVarMap(connections);
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

export function buildConnectionEnvVarMap(connections: SetupConnection[]): Map<string, string> {
  const result = new Map<string, string>();
  const claimed = new Set<string>();

  for (const conn of connections) {
    let envVarName = PROVIDER_KEY_MAP[conn.provider] ?? "OPENAI_API_KEY";
    if (claimed.has(envVarName)) envVarName = `${envVarName}_${conn.id}`;
    const upperKey = envVarName.toUpperCase();
    if (!SAFE_ENV_KEY_RE.test(upperKey)) {
      logger.warn("skipping connection with unsafe env var key", { connectionId: conn.id, envVarName });
      continue;
    }
    claimed.add(upperKey);
    result.set(conn.id, upperKey);
  }
  return result;
}

// ── Channel Credential Env Var Mapping ───────────────────────────────────

const CHANNEL_CREDENTIAL_ENV_MAP: Record<string, Record<string, string>> = {
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

function buildChannelCredentialEnvVars(
  channelCredentials: Record<string, Record<string, string>>
): Record<string, string> {
  const envVars: Record<string, string> = {};
  for (const [channelId, creds] of Object.entries(channelCredentials)) {
    const mapping = CHANNEL_CREDENTIAL_ENV_MAP[channelId];
    if (!mapping) continue;
    for (const [field, envKey] of Object.entries(mapping)) {
      const val = creds[field];
      if (typeof val === "string" && val) envVars[envKey] = val;
    }
  }
  return envVars;
}

// ── Core Setup Orchestration ─────────────────────────────────────────────

export async function performSetup(
  input: SetupSpec,
  opts?: { state?: ControlPlaneState }
): Promise<SetupResult> {
  const validation = validateSetupSpec(input);
  if (!validation.valid) return { ok: false, error: validation.errors.join("; ") };

  const { spec, security, owner, connections, channelCredentials } = input;
  const ollamaEnabled = hasAddon(spec, "ollama");

  logger.info("performing setup", { connectionCount: connections.length, ollamaEnabled });

  const state = opts?.state ?? createState(security.adminToken);

  // Apply Ollama in-stack URL override when addon is enabled
  const effectiveConnections = ollamaEnabled
    ? connections.map((c) => c.provider === "ollama" ? { ...c, baseUrl: OLLAMA_INSTACK_URL } : c)
    : connections;
  const connEnvVarMap = buildConnectionEnvVarMap(effectiveConnections);
  const updates = buildSecretsFromSetup(effectiveConnections, owner);

  // Persist vault env files
  try {
    ensureHomeDirs();
    ensureSecrets(state);
    const existingSystemEnv = readSystemSecretsEnvFile(state.vaultDir);
    if (channelCredentials) Object.assign(updates, buildChannelCredentialEnvVars(channelCredentials));
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

  // Resolve connection details from capabilities
  const memErr = writeMemoryAndStackConfigs(spec, effectiveConnections, connEnvVarMap, state);
  if (memErr) return memErr;

  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig();
  ensureMemoryDir();

  // Mark setup complete
  const dataStackEnv = `${state.dataDir}/stack.env`;
  mkdirSync(state.dataDir, { recursive: true });
  const stackBase = existsSync(dataStackEnv) ? readFileSync(dataStackEnv, "utf-8") : "";
  writeFileSync(dataStackEnv, mergeEnvContent(stackBase, { OP_SETUP_COMPLETE: "true" }));

  await applyInstall(state);

  logger.info("setup complete", { connectionCount: connections.length });
  return { ok: true };
}

/** Resolve capabilities, write stack.yaml and managed.env. Returns error result or null. */
function writeMemoryAndStackConfigs(
  spec: StackSpec, connections: SetupConnection[], connEnvVarMap: Map<string, string>, state: ControlPlaneState
): SetupResult | null {
  const { provider: llmProvider } = parseCapabilityString(spec.capabilities.llm);
  const { provider: embProvider, model: embModel } = spec.capabilities.embeddings;
  const resolvedDims = spec.capabilities.embeddings.dims || EMBEDDING_DIMS[`${embProvider}/${embModel}`] || 1536;

  const llmConn = connections.find((c) => c.provider === llmProvider);
  if (!llmConn) return { ok: false, error: `No connection found for LLM provider "${llmProvider}"` };
  const embConn = connections.find((c) => c.provider === embProvider);
  if (!embConn) return { ok: false, error: `No connection found for embeddings provider "${embProvider}"` };

  const llmEnvVar = connEnvVarMap.get(llmConn.id);
  if (!llmEnvVar) return { ok: false, error: `No env var mapping found for LLM connection "${llmConn.id}"` };
  const embEnvVar = connEnvVarMap.get(embConn.id);
  if (!embEnvVar) return { ok: false, error: `No env var mapping found for embeddings connection "${embConn.id}"` };

  const specToWrite: StackSpec = {
    ...spec,
    capabilities: { ...spec.capabilities, embeddings: { ...spec.capabilities.embeddings, dims: resolvedDims } },
  };
  writeStackSpec(state.configDir, specToWrite);
  writeManagedEnvFiles(specToWrite, state.vaultDir);

  return null;
}
