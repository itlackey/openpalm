/**
 * Shared setup orchestration for the OpenPalm control plane.
 *
 * Both the CLI setup wizard and the admin UI call `performSetup()`.
 * This module does NOT include Docker operations (compose up, image pull, etc.)
 * — those happen separately in the caller after setup completes.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import {
  PROVIDER_KEY_MAP,
} from "../provider-constants.js";
import { mergeEnvContent } from "./env.js";
import { ensureHomeDirs } from "./home.js";
import { acquireInstallLock, releaseInstallLock, type InstallLockHandle } from "./install-lock.js";
import {
  ensureSecrets,
  updateSecretsEnv,
  patchSecretsEnvFile,
  ensureOpenCodeConfig,
  readStackEnv,
  writeAuthJsonProviderKeys,
} from "./secrets.js";
import { createState } from "./lifecycle.js";
import { readStackSpec, writeStackSpec } from "./stack-spec.js";
import { writeVoiceVars } from "./spec-to-env.js";
import type { ControlPlaneState } from "./types.js";
import { validateSetupSpec } from "./setup-validation.js";
import { getRegistryAutomation, setAddonEnabled, setAddonProfileSelection } from "./registry.js";
export { validateSetupSpec } from "./setup-validation.js";

const logger = createLogger("setup");

// ── Atomic write helper ──────────────────────────────────────────────────

/**
 * Write `content` to `path` atomically: write to `path.tmp` first, then
 * rename over the target. On POSIX this rename is atomic — a reader always
 * sees either the old file or the new file, never a partially-written one.
 * If the tmp write fails the original file is untouched.
 */
function writeFileAtomic(path: string, content: string | Uint8Array, mode?: number): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, mode !== undefined ? { mode } : {});
  renameSync(tmp, path);
}

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
  /**
   * Operator-supplied UI login password. Persisted as a file-based secret.
   */
  security: { uiLoginPassword: string };
  owner?: { name?: string; email?: string };
  connections: SetupConnection[];
  channelCredentials?: Record<string, Record<string, string>>;
  addons?: Record<string, boolean>;
  voiceProfile?: string;
  ollamaProfile?: string;
  imageTag?: string;
  hostAkm?: boolean;
};

// ── Secrets Builder ──────────────────────────────────────────────────────

/**
 * Build the non-secret stack.env update payload from a setup spec.
 * Provider API keys and channel credentials are written as file-based secrets.
 */
export function buildSecretsFromSetup(
  connections: SetupConnection[],
  owner?: { name?: string; email?: string },
): Record<string, string> {
  const updates: Record<string, string> = {};
  const ownerName = (owner?.name?.trim() ?? "").replace(/[\r\n\0]/g, "").slice(0, 200);
  const ownerEmail = (owner?.email?.trim() ?? "").replace(/[\r\n\0]/g, "").slice(0, 200);
  if (ownerName) updates.OP_OWNER_NAME = ownerName;
  if (ownerEmail) updates.OP_OWNER_EMAIL = ownerEmail;
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

/**
 * Build the system-secret update for the wizard / CLI install path.
 *
 * Phase 4 of the auth/proxy refactor collapsed the legacy
 * `OP_UI_TOKEN` / `OP_ASSISTANT_TOKEN` pair into a single operator login
 * secret (`OP_UI_LOGIN_PASSWORD`). The browser stores the cookie value =
 * password; `requireAdmin()` compares the cookie against
 * `process.env.OP_UI_LOGIN_PASSWORD` via the existing `safeTokenCompare`.
 *
  * `OP_OPENCODE_PASSWORD` may be supplied explicitly as a file-based secret in
  * `knowledge/secrets/op_opencode_password` when OpenCode auth is enabled.
 *
 * `existingSystemEnv` is unused now but the parameter is kept so callers
 * compile unchanged. It can be removed in a follow-up cleanup.
 */
export function buildSystemSecretsFromSetup(
  uiLoginPassword: string,
  _existingSystemEnv: Record<string, string> = {}
): Record<string, string> {
  return {
    OP_UI_LOGIN_PASSWORD: uiLoginPassword,
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

  const { llm, embedding, tts, stt, security, owner, connections, channelCredentials, addons, voiceProfile, ollamaProfile, imageTag, hostAkm } = input;
  const state = opts?.state ?? createState();

  // Acquire install lock to prevent two concurrent setup runs from racing on
  // the same config directory. The lock lives in dataDir so it is co-located
  // with runtime state and the same path startDeploy uses.
  const lockHandle: InstallLockHandle | null = acquireInstallLock(state.dataDir);
  if (lockHandle === null) {
    return {
      ok: false,
      error:
        "install_in_progress: Another install is in progress. Wait for it to finish, or remove state/.install.lock if you're sure no install is running.",
    };
  }

  logger.info("performing setup", { connectionCount: connections.length });
  const updates = buildSecretsFromSetup(connections, owner);
  const providerKeys = buildAuthJsonFromSetup(connections);

  // Wrap all persistence work in try/finally so the lock is ALWAYS released.
  try {
    // Persist vault env files + OpenCode auth.json
    try {
      ensureHomeDirs();
      ensureSecrets(state);
      const existingSystemEnv = readStackEnv(state.stackDir);
      const channelSecretUpdates = channelCredentials ? buildChannelCredentialEnvVars(channelCredentials) : {};
      // Pick up channel credential env vars not already provided in the spec
      for (const mapping of Object.values(CHANNEL_CREDENTIAL_ENV_MAP)) {
        for (const envKey of Object.values(mapping)) {
          if (!channelSecretUpdates[envKey] && process.env[envKey]) channelSecretUpdates[envKey] = process.env[envKey];
        }
      }
      updateSecretsEnv(state, updates);
      updateSecretsEnv(state, channelSecretUpdates);
      patchSecretsEnvFile(state.stackDir, buildSystemSecretsFromSetup(security.uiLoginPassword, existingSystemEnv));
      // Provider API keys land in OpenCode's auth.json (bind-mounted into
      // the assistant container) — never in stack.env.
      writeAuthJsonProviderKeys(state, providerKeys);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("failed to persist setup outputs", { error: message });
      return { ok: false, error: `Failed to persist setup outputs: ${message}` };
    }

    // Everything from here through the OP_SETUP_COMPLETE write is wrapped in a
    // single try/catch so that a disk-full or permission-denied mid-way returns a
    // clean error rather than leaving a broken half-installed ~/.openpalm/.
    try {
      // Preserve addon enablement while refreshing the stack schema marker.
      writeStackSpec(state.stackDir, readStackSpec(state.stackDir) ?? { version: 2 });

      // Write image tag and AKM mount paths to stack.env — atomic to avoid
      // partial writes if the process is interrupted mid-write.
      const systemEnvForAkm = existsSync(`${state.stashDir}/env/stack.env`)
        ? readFileSync(`${state.stashDir}/env/stack.env`, "utf-8")
        : "";
      const akmUpdates: Record<string, string> = {};
      if (imageTag) akmUpdates.OP_IMAGE_TAG = imageTag;
      if (hostAkm) {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
        if (home) {
          akmUpdates.OP_AKM_STASH = `${home}/akm`;
          akmUpdates.OP_AKM_CONFIG = `${home}/.config/akm`;
        }
      }
      if (Object.keys(akmUpdates).length > 0) {
        writeFileAtomic(`${state.stashDir}/env/stack.env`, mergeEnvContent(systemEnvForAkm, akmUpdates), 0o600);
      }

      // Write akm config with LLM and embedding settings from setup — atomic.
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
        writeFileAtomic(akmConfigPath, JSON.stringify(updated, null, 2), 0o600);
      }

      // Write TTS/STT vars to stack.env for the voice channel
      if (tts || stt) {
        writeVoiceVars({ tts, stt }, state.stackDir);
      }

      // Enable requested addons (channels like discord, slack, etc.)
      // setAddonEnabled records explicit activation state and ensures channel secret files.
      if (addons) {
        for (const [name, enabled] of Object.entries(addons)) {
          if (enabled) setAddonEnabled(state.homeDir, state.stackDir, name, true, state);
        }
      }


      if (voiceProfile?.trim()) {
        setAddonProfileSelection(state.stackDir, 'voice', voiceProfile.trim(), state);
      }

      if (ollamaProfile?.trim()) {
        setAddonProfileSelection(state.stackDir, 'ollama', ollamaProfile.trim(), state);
      }

      ensureOpenCodeConfig();

      // Seed default automation into the AKM stash. Idempotent — existing files
      // are left alone so user edits survive re-install and upgrade.
      const tasksDir = join(state.stashDir, "tasks");
      mkdirSync(tasksDir, { recursive: true });
      const akmImproveDest = join(tasksDir, "akm-improve.yml");
      if (!existsSync(akmImproveDest)) {
        const akmImproveTask = getRegistryAutomation("akm-improve");
        if (akmImproveTask) {
          writeFileSync(akmImproveDest, akmImproveTask);
          logger.info("seeded default automation", { name: "akm-improve" });
        } else {
          logger.warn("default automation missing from registry; skipping seed", {
            name: "akm-improve",
          });
        }
      }

      // NOTE: OP_SETUP_COMPLETE is intentionally NOT written here. Writing it
      // before the Docker deploy succeeds would mark setup "complete" even
      // when containers fail to start, sending the user to a broken admin UI
      // with no path back to the wizard. The flag is now written by
      // setup-deploy.ts:startDeploy AFTER pollContainerHealth confirms every
      // container is healthy.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("failed to complete setup persistence", { error: message });
      return { ok: false, error: `Setup persistence failed: ${message}` };
    }

    logger.info("setup complete", { connectionCount: connections.length });
    return { ok: true };
  } finally {
    // Always release the install lock, whether setup succeeded or failed.
    releaseInstallLock(lockHandle);
  }
}
