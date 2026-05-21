/**
 * Shared setup orchestration for the OpenPalm control plane.
 *
 * Both the CLI setup wizard and the admin UI call `performSetup()`.
 * This module does NOT include Docker operations (compose up, image pull, etc.)
 * — those happen separately in the caller after setup completes.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createLogger } from "../logger.js";
import {
  PROVIDER_KEY_MAP,
} from "../provider-constants.js";
import { mergeEnvContent } from "./env.js";
import { ensureHomeDirs } from "./home.js";
import {
  ensureSecrets,
  updateSecretsEnv,
  updateSystemSecretsEnv,
  ensureOpenCodeConfig,
  readStackEnv,
  writeAuthJsonProviderKeys,
} from "./secrets.js";
import { ensureOpenCodeSystemConfig } from "./core-assets.js";
import { createState } from "./lifecycle.js";
import { mirrorUserVaultToAkm, migrateAndCleanupLegacyUserEnv } from "./akm-vault.js";
import { writeStackSpec } from "./stack-spec.js";
import { writeVoiceVars } from "./spec-to-env.js";
import type { ControlPlaneState } from "./types.js";
import { validateSetupSpec } from "./setup-validation.js";
import { getRegistryAutomation } from "./registry.js";
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
  version: 2;
  llm?: { provider: string; model: string; baseUrl?: string };
  embedding?: { provider: string; model: string; dims: number; baseUrl?: string };
  tts?: { enabled?: boolean; engine?: string; provider?: string; baseURL?: string; model?: string; voice?: string };
  stt?: { enabled?: boolean; engine?: string; provider?: string; baseURL?: string; model?: string; language?: string };
  security: { adminToken: string };
  owner?: { name?: string; email?: string };
  connections: SetupConnection[];
  channelCredentials?: Record<string, Record<string, string>>;
};

// ── Secrets Builder ──────────────────────────────────────────────────────

/**
 * Build the stack.env update payload from a setup spec. Provider API
 * keys are NOT included here — credentials live in OpenCode's auth.json
 * (see buildAuthJsonFromSetup), not stack.env. This function returns
 * only non-credential vars: owner identity and similar.
 */
export function buildSecretsFromSetup(
  connections: SetupConnection[],
  owner?: { name?: string; email?: string },
): Record<string, string> {
  const updates: Record<string, string> = {};
  const ownerName = (owner?.name?.trim() ?? "").replace(/[\r\n\0]/g, "").slice(0, 200);
  const ownerEmail = (owner?.email?.trim() ?? "").replace(/[\r\n\0]/g, "").slice(0, 200);
  if (ownerName) updates.OWNER_NAME = ownerName;
  if (ownerEmail) updates.OWNER_EMAIL = ownerEmail;
  void connections;
  return updates;
}

/**
 * Build the auth.json payload from a setup spec. Returns a record of
 * `{ providerId: apiKey }` ready to feed into writeAuthJsonProviderKeys.
 * Pulls keys from the spec first, falling back to the host process
 * environment for the canonical env var name (e.g. OPENAI_API_KEY for
 * provider "openai") so operators can preload keys via env before
 * running the wizard.
 */
export function buildAuthJsonFromSetup(
  connections: SetupConnection[],
): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const cap of connections) {
    const envVar = PROVIDER_KEY_MAP[cap.provider];
    const key = cap.apiKey || (envVar ? process.env[envVar] : undefined) || "";
    if (key) keys[cap.provider] = key;
  }
  return keys;
}

export function buildSystemSecretsFromSetup(
  adminToken: string,
  existingSystemEnv: Record<string, string> = {}
): Record<string, string> {
  return {
    OP_UI_TOKEN: adminToken,
    OP_ASSISTANT_TOKEN: existingSystemEnv.OP_ASSISTANT_TOKEN || randomBytes(32).toString("hex"),
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

  const { llm, embedding, tts, stt, security, owner, connections, channelCredentials } = input;
  const state = opts?.state ?? createState(security.adminToken);
  logger.info("performing setup", { connectionCount: connections.length });
  const updates = buildSecretsFromSetup(connections, owner);
  const providerKeys = buildAuthJsonFromSetup(connections);

  // Persist vault env files + OpenCode auth.json
  try {
    ensureHomeDirs();
    ensureSecrets(state);
    const existingSystemEnv = readStackEnv(state.stackDir);
    if (channelCredentials) Object.assign(updates, buildChannelCredentialEnvVars(channelCredentials));
    // Pick up channel credential env vars not already provided in the spec
    for (const mapping of Object.values(CHANNEL_CREDENTIAL_ENV_MAP)) {
      for (const envKey of Object.values(mapping)) {
        if (!updates[envKey] && process.env[envKey]) updates[envKey] = process.env[envKey];
      }
    }
    updateSecretsEnv(state, updates);
    updateSystemSecretsEnv(state, buildSystemSecretsFromSetup(security.adminToken, existingSystemEnv));
    // Provider API keys land in OpenCode's auth.json (bind-mounted into
    // the assistant container) — never in stack.env.
    writeAuthJsonProviderKeys(state, providerKeys);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("failed to persist setup outputs", { error: message });
    return { ok: false, error: `Failed to persist setup outputs: ${message}` };
  }

  state.adminToken = security.adminToken;
  state.assistantToken = readStackEnv(state.stackDir).OP_ASSISTANT_TOKEN ?? state.assistantToken;
  // Phase 1 of #388 §B.2: state.setupToken is held in memory only.
  // Previously persisted to `${dataDir}/setup-token.txt`; that file
  // is now ephemeral. The setup wizard server owns the token lifetime
  // directly. Future callers needing cross-process access should use
  // `${XDG_RUNTIME_DIR}` (tmpfs) rather than the stash data dir.

  // Write stack.yml (version marker only)
  writeStackSpec(state.stackDir, { version: 2 });

  // Write akm config with LLM and embedding settings from setup
  if (llm || embedding) {
    const akmConfigDir = join(state.configDir, "akm");
    mkdirSync(akmConfigDir, { recursive: true });
    const akmConfigPath = join(akmConfigDir, "config.json");
    let existing: Record<string, unknown> = {};
    if (existsSync(akmConfigPath)) {
      try { existing = JSON.parse(readFileSync(akmConfigPath, "utf-8")); } catch { /* ignore corrupt */ }
    }
    const updated = { ...existing };
    if (llm) {
      const base = llm.baseUrl ? llm.baseUrl.replace(/\/+$/, "") : "";
      updated.llm = {
        ...((existing.llm as Record<string, unknown>) ?? {}),
        endpoint: base ? `${base}/chat/completions` : "",
        model: llm.model,
        provider: llm.provider,
      };
    }
    if (embedding) {
      const base = embedding.baseUrl ? embedding.baseUrl.replace(/\/+$/, "") : "";
      updated.embedding = {
        ...((existing.embedding as Record<string, unknown>) ?? {}),
        endpoint: base ? `${base}/embeddings` : "",
        model: embedding.model,
        provider: embedding.provider,
        dimension: embedding.dims,
      };
    }
    writeFileSync(akmConfigPath, JSON.stringify(updated, null, 2), { mode: 0o600 });
  }

  // Write TTS/STT vars to stack.env for the voice channel
  if (tts || stt) {
    writeVoiceVars({ tts, stt }, state.stackDir);
  }

  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig();

  // Seed default automation into the AKM stash. Idempotent — existing files
  // are left alone so user edits survive re-install and upgrade.
  const tasksDir = join(state.stashDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const akmImproveDest = join(tasksDir, "akm-improve.md");
  if (!existsSync(akmImproveDest)) {
    const akmImproveMd = getRegistryAutomation("akm-improve");
    if (akmImproveMd) {
      writeFileSync(akmImproveDest, akmImproveMd);
      logger.info("seeded default automation", { name: "akm-improve" });
    } else {
      logger.warn("default automation missing from registry; skipping seed", {
        name: "akm-improve",
      });
    }
  }

  // Mark setup complete in config/stack/stack.env (where isSetupComplete reads it)
  const systemEnvPath = `${state.stackDir}/stack.env`;
  const systemBase = existsSync(systemEnvPath) ? readFileSync(systemEnvPath, "utf-8") : "";
  writeFileSync(systemEnvPath, mergeEnvContent(systemBase, { OP_SETUP_COMPLETE: "true" }), { mode: 0o600 });

  // Phase 2 of #388 (closes #406): the akm `vault:user` store is now the
  // sole runtime source of truth for user-managed env secrets. On a
  // legacy install we migrate any `vault/user/user.env` content into akm
  // and delete the file. On a fresh install no user.env is created, so
  // the migration is a no-op (mirror reports `skipped: user.env missing`).
  // Both steps are best-effort — a missing or wedged akm CLI must never
  // block setup completion.
  try {
    const mirror = await mirrorUserVaultToAkm(state);
    if (mirror.skipped) {
      logger.debug("vault:user mirror skipped", { reason: mirror.reason });
    } else {
      logger.info("vault:user mirror complete", {
        written: mirror.written.length,
        unchanged: mirror.unchanged.length,
      });
    }
    const cleanup = await migrateAndCleanupLegacyUserEnv(state);
    if (cleanup.deleted) {
      logger.info("removed legacy vault/user/user.env after akm migration");
    } else if (cleanup.reason && cleanup.reason !== "user.env already absent") {
      logger.debug("legacy user.env retained", { reason: cleanup.reason });
    }
  } catch (err) {
    logger.warn("vault:user mirror failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info("setup complete", { connectionCount: connections.length });
  return { ok: true };
}
