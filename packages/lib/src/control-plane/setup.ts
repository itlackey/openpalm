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
  readStackEnv,
} from "./secrets.js";
import { ensureOpenCodeSystemConfig, ensureMemoryDir } from "./core-assets.js";
import { createState, writeSetupTokenFile } from "./lifecycle.js";
import { writeStackSpec } from "./stack-spec.js";
import type { StackSpec } from "./stack-spec.js";
import { writeCapabilityVars } from "./spec-to-env.js";
import type { ControlPlaneState } from "./types.js";
import { validateSetupSpec } from "./setup-validation.js";
import { listEnabledAddonIds } from "./registry.js";
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

  for (const conn of connections) {
    if (conn.apiKey) {
      const envVar = PROVIDER_KEY_MAP[conn.provider];
      if (envVar) updates[envVar] = conn.apiKey;
    }
    // Persist user-configured base URL so writeCapabilityVars can read it
    if (conn.baseUrl && conn.provider === "openai") {
      updates.OPENAI_BASE_URL = conn.baseUrl;
    }
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
  const state = opts?.state ?? createState(security.adminToken);
  const ollamaEnabled = listEnabledAddonIds(state.homeDir).includes("ollama");

  logger.info("performing setup", { connectionCount: connections.length, ollamaEnabled });

  // Apply Ollama in-stack URL override when addon is enabled
  const effectiveConnections = ollamaEnabled
    ? connections.map((c) => c.provider === "ollama" ? { ...c, baseUrl: OLLAMA_INSTACK_URL } : c)
    : connections;
  const updates = buildSecretsFromSetup(effectiveConnections, owner);

  // Persist vault env files
  try {
    ensureHomeDirs();
    ensureSecrets(state);
    const existingSystemEnv = readStackEnv(state.vaultDir);
    if (channelCredentials) Object.assign(updates, buildChannelCredentialEnvVars(channelCredentials));
    updateSecretsEnv(state, updates);
    updateSystemSecretsEnv(state, buildSystemSecretsFromSetup(security.adminToken, existingSystemEnv));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("failed to update vault env files", { error: message });
    return { ok: false, error: `Failed to update vault env files: ${message}` };
  }

  state.adminToken = security.adminToken;
  state.assistantToken = readStackEnv(state.vaultDir).OP_ASSISTANT_TOKEN ?? state.assistantToken;
  writeSetupTokenFile(state);

  // Write stack.yml and OP_CAP_* capability vars to stack.env
  writeMemoryAndStackConfigs(spec, state);

  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig();
  ensureMemoryDir();

  // Mark setup complete in vault/stack/stack.env (where isSetupComplete reads it)
  const systemEnvPath = `${state.vaultDir}/stack/stack.env`;
  const systemBase = existsSync(systemEnvPath) ? readFileSync(systemEnvPath, "utf-8") : "";
  writeFileSync(systemEnvPath, mergeEnvContent(systemBase, { OP_SETUP_COMPLETE: "true" }), { mode: 0o600 });

  logger.info("setup complete", { connectionCount: connections.length });
  return { ok: true };
}

/** Write stack.yml and OP_CAP_* capability vars to stack.env from the spec's capabilities. */
function writeMemoryAndStackConfigs(spec: StackSpec, state: ControlPlaneState): void {
  const { provider: embProvider, model: embModel } = spec.capabilities.embeddings;
  const resolvedDims = spec.capabilities.embeddings.dims || EMBEDDING_DIMS[`${embProvider}/${embModel}`] || 1536;

  const specToWrite: StackSpec = {
    ...spec,
    capabilities: { ...spec.capabilities, embeddings: { ...spec.capabilities.embeddings, dims: resolvedDims } },
  };
  writeStackSpec(state.configDir, specToWrite);
  writeCapabilityVars(specToWrite, state.vaultDir);
}
