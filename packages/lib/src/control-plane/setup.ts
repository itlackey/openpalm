/**
 * Shared setup orchestration for the OpenPalm control plane.
 *
 * Both the CLI setup wizard and the admin UI call `performSetup()`.
 * This module does NOT include Docker operations (compose up, image pull, etc.)
 * — those happen separately in the caller after setup completes.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { errMessage } from "./errors.js";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { enableHostAkmSharing, disableHostAkmSharing } from "./host-akm-sharing.js";
import { addHostStashToOpenpalmConfig } from "./akm-sources.js";
import {
  PROVIDER_KEY_MAP,
} from "../provider-constants.js";
import { buildAkmEndpoint } from './akm-endpoints.js';
import { mergeEnvContent } from "./env.js";
import { SERVICE_VERSION_KEYS } from "./versions.js";
import { ensureHomeDirs } from "./home.js";
import { acquireInstallLock, releaseInstallLock, type InstallLockHandle } from "./install-lock.js";
import {
  ensureSecrets,
  updateSecretsEnv,
  patchSecretsEnvFile,
  ensureOpenCodeConfig,
  writeAuthJsonProviderKeys,
} from "./secrets.js";
import { createState, initializeStateSecrets } from "./lifecycle.js";
import { writeVoiceVars } from "./voice-env.js";
import type { ControlPlaneState } from "./types.js";
import { validateSetupSpec } from "./setup-validation.js";
import { getRegistryAutomation, setAddonEnabled, setAddonProfileSelection } from "./addons.js";
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
  /**
   * Operator-supplied UI login password. Persisted as a file-based secret.
   */
  security: { uiLoginPassword: string };
  owner?: { name?: string; email?: string };
  connections: SetupConnection[];
  portalCredentials?: Record<string, Record<string, string>>;
  addons?: Record<string, boolean>;
  voiceProfile?: string;
  ollamaProfile?: string;
  imageTag?: string;
  hostAkm?: boolean;
};

// ── Secrets Builder ──────────────────────────────────────────────────────

/**
 * Build the non-secret stack.env update payload from a setup spec.
 * Extracts owner name/email into OP_OWNER_* env vars.
 */
export function buildOwnerEnvFromSetup(
  owner?: { name?: string; email?: string },
): Record<string, string> {
  const updates: Record<string, string> = {};
  const ownerName = (owner?.name?.trim() ?? "").replace(/[\r\n\0]/g, "").slice(0, 200);
  const ownerEmail = (owner?.email?.trim() ?? "").replace(/[\r\n\0]/g, "").slice(0, 200);
  if (ownerName) updates.OP_OWNER_NAME = ownerName;
  if (ownerEmail) updates.OP_OWNER_EMAIL = ownerEmail;
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

// ── Portal Credential Env Var Mapping ───────────────────────────────────

const PORTAL_CREDENTIAL_ENV_MAP: Record<string, Record<string, string>> = {
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

function buildPortalCredentialEnvVars(
  portalCredentials: Record<string, Record<string, string>>
): Record<string, string> {
  const envVars: Record<string, string> = {};
  for (const [portalId, creds] of Object.entries(portalCredentials)) {
    const mapping = PORTAL_CREDENTIAL_ENV_MAP[portalId];
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

  const { llm, embedding, tts, stt, security, owner, connections, portalCredentials, addons, voiceProfile, ollamaProfile, imageTag, hostAkm } = input;
  const state = opts?.state ?? createState();
  initializeStateSecrets(state);

  // Acquire install lock to prevent two concurrent setup runs from racing on
  // the same config directory. The lock lives in dataDir so it is co-located
  // with runtime state and the same path startDeploy uses.
  const lockHandle: InstallLockHandle | null = acquireInstallLock(state.dataDir);
  if (lockHandle === null) {
    return {
      ok: false,
      error:
        "install_in_progress: Another install is in progress. Wait for it to finish (the lock clears itself automatically after 30 minutes). If you're sure nothing is running, run 'openpalm unlock' to clear a stale lock.",
    };
  }

  logger.info("performing setup", { connectionCount: connections.length });
  const updates = buildOwnerEnvFromSetup(owner);
  const providerKeys = buildAuthJsonFromSetup(connections);

  // Wrap all persistence work in try/finally so the lock is ALWAYS released.
  try {
    // Persist vault env files + OpenCode auth.json
    try {
      ensureHomeDirs();
      ensureSecrets(state);
      const portalSecretUpdates = portalCredentials ? buildPortalCredentialEnvVars(portalCredentials) : {};
      // Pick up portal credential env vars not already provided in the spec
      for (const mapping of Object.values(PORTAL_CREDENTIAL_ENV_MAP)) {
        for (const envKey of Object.values(mapping)) {
          if (!portalSecretUpdates[envKey] && process.env[envKey]) portalSecretUpdates[envKey] = process.env[envKey];
        }
      }
      updateSecretsEnv(state, updates);
      updateSecretsEnv(state, portalSecretUpdates);
      patchSecretsEnvFile(state.homeDir, { OP_UI_LOGIN_PASSWORD: security.uiLoginPassword });
      // Provider API keys land in OpenCode's auth.json (bind-mounted into
      // the assistant container) — never in stack.env.
      writeAuthJsonProviderKeys(state, providerKeys);
    } catch (err) {
      const message = errMessage(err);
      logger.error("failed to persist setup outputs", { error: message });
      return { ok: false, error: `Failed to persist setup outputs: ${message}` };
    }

    // Everything from here through the OP_SETUP_COMPLETE write is wrapped in a
    // single try/catch so that a disk-full or permission-denied mid-way returns a
    // clean error rather than leaving a broken half-installed ~/.openpalm/.
    try {
      // Write image tag and AKM mount paths to stack.env — atomic to avoid
      // partial writes if the process is interrupted mid-write.
      const systemEnvForAkm = existsSync(`${state.stashDir}/env/stack.env`)
        ? readFileSync(`${state.stashDir}/env/stack.env`, "utf-8")
        : "";
      const akmUpdates: Record<string, string> = {};
      // Reconcile the per-image version pins on EVERY setup run. A non-empty
      // wizard value pins every service image to that exact tag deliberately; a
      // BLANK field means "track the moving default", so write `latest` rather
      // than silently preserving a stale pin left in an existing stack.env.
      // Without this, re-running setup over an OP_HOME whose versions were pinned
      // to an old release kept deploying a months-old image. Each image now has
      // its own OP_*_VERSION var (no single OP_IMAGE_TAG cascade); the Advanced
      // field pins all four to the same tag.
      const requestedTag = imageTag && imageTag.trim() ? imageTag.trim() : "latest";
      for (const key of SERVICE_VERSION_KEYS) {
        akmUpdates[key] = requestedTag;
      }
      // NOTE: host-akm sharing no longer repoints the container's primary stash
      // (the old OP_AKM_STASH/OP_AKM_CONFIG split-brain). The personal ~/akm is
      // wired as a read-write SECONDARY source — see configureHostAkmSharing()
      // below (Phase 4) and the host-akm.compose.yml overlay.
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
          // Write the CANONICAL akm 0.8.0 shape: profiles.llm.default + defaults.llm.
          // The runtime resolver reads profiles.llm[defaults.llm] (akm config.ts).
          // Do NOT write a top-level `llm` — akm's top-level schema is .strict()
          // with no `llm` key (config-schema.ts AkmConfigShape). A top-level `llm`
          // only loads today via akm's legacy 0.7→0.8 migration shim
          // (config-migration.ts), which rewrites the file on load and is marked
          // for removal — writing the native shape removes that dependency.
          const profiles = (updated.profiles as Record<string, unknown>) ?? {};
          const llmProfiles = (profiles.llm as Record<string, unknown>) ?? {};
          llmProfiles.default = {
            ...((llmProfiles.default as Record<string, unknown>) ?? {}),
            endpoint: buildAkmEndpoint(llm.provider, llm.baseUrl, "/chat/completions"),
            model: llm.model,
            provider: llm.provider,
          };
          profiles.llm = llmProfiles;
          updated.profiles = profiles;
          const defaults = (updated.defaults as Record<string, unknown>) ?? {};
          if (typeof defaults.llm !== "string") defaults.llm = "default";
          updated.defaults = defaults;
          delete (updated as Record<string, unknown>).llm; // never persist the legacy key
        }
        if (embedding) {
          updated.embedding = {
            ...((existing.embedding as Record<string, unknown>) ?? {}),
            endpoint: buildAkmEndpoint(embedding.provider, embedding.baseUrl, "/embeddings"),
            model: embedding.model,
            provider: embedding.provider,
            dimension: embedding.dims,
          };
        }
        // The assistant's primary stash is ALWAYS /stash (the bind mount). Pin it
        // in config so it is explicit and operator-edits can't repoint it; the UI
        // does not expose stashDir. (The host task-runner still uses its own
        // AKM_STASH_DIR env, which takes precedence over config.stashDir.)
        updated.stashDir = "/stash";
        writeFileAtomic(akmConfigPath, JSON.stringify(updated, null, 2), 0o600);
      }

      // Host AKM sharing. /host-stash is ALWAYS a secondary source in the akm
      // config — written once here, never removed. The compose bind-mount
      // controls what actually arrives at /host-stash: the real ~/akm when
      // OP_HOST_AKM_STASH is set (enabled), or the always-present empty dir
      // when it is unset (disabled). Profile import is best-effort on enable.
      addHostStashToOpenpalmConfig(state);
      if (hostAkm !== false) {
        const { profilesImported } = enableHostAkmSharing(state);
        logger.info("host akm sharing enabled during setup", { profilesImported });
      } else {
        disableHostAkmSharing(state);
      }

      // Write TTS/STT vars to stack.env for the voice channel
      if (tts || stt) {
        writeVoiceVars({ tts, stt }, state.homeDir);
      }

      // Enable requested addons (portals like discord, slack, etc.)
      // setAddonEnabled records explicit activation state and ensures portal secret files.
      if (addons) {
        for (const [name, enabled] of Object.entries(addons)) {
          if (enabled) setAddonEnabled(state.homeDir, name, true, state);
        }
      }


      if (voiceProfile?.trim()) {
        setAddonProfileSelection(state.homeDir, 'voice', voiceProfile.trim());
      }

      if (ollamaProfile?.trim()) {
        setAddonProfileSelection(state.homeDir, 'ollama', ollamaProfile.trim());
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
      const message = errMessage(err);
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
