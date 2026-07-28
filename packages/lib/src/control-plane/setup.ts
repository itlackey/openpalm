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
import { SERVICE_VERSION_KEYS, writeVersions } from "./versions.js";
import { PLATFORM_VERSION } from "./versioning.js";
import { dockerManifestExists } from "./addon-availability.js";
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
import { readSecret } from "./secrets-files.js";
import type { ControlPlaneState } from "./types.js";
import { validateSetupSpec } from "./setup-validation.js";
import { getRegistryAutomation, listEnabledAddonIds, setAddonEnabled, setAddonProfileSelection } from "./addons.js";
import { GUARDIAN_INGRESS_ADDON_IDS } from "./addon-ids.js";
import {
  coerceAccessToggles,
  requiresAssistantKey,
  resolveAccessEnv,
  type AccessToggles,
} from "./access-toggles.js";
import { randomHex } from "./crypto.js";
export { validateSetupSpec } from "./setup-validation.js";

const logger = createLogger("setup");

/**
 * Map each service version key to the Docker image name it tags. Used to probe
 * each image independently before pinning it to PLATFORM_VERSION (E1 / Codex
 * #2). OP_VOICE_VERSION is intentionally absent — voice is never pinned to a
 * bare semver tag (its tags are GPU-variant suffixed).
 */
const SERVICE_IMAGE_FOR_VERSION_KEY: Record<string, string> = {
  OP_ASSISTANT_VERSION: "assistant",
  OP_GUARDIAN_VERSION: "guardian",
  OP_PORTAL_VERSION: "portal",
};

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
  /**
   * Operator-supplied UI login password. Persisted as a file-based secret.
   */
  security: { uiLoginPassword?: string };
  owner?: { name?: string; email?: string };
  connections: SetupConnection[];
  portalCredentials?: Record<string, Record<string, string>>;
  addons?: Record<string, boolean>;
  voiceProfile?: string;
  ollamaProfile?: string;
  imageTag?: string;
  hostAkm?: boolean;
  /**
   * Network access toggles. Absent = leave network config untouched, so a
   * rerun the operator did not touch never rewrites their exposure.
   */
  access?: Partial<AccessToggles>;
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

// ── AKM Config Persistence ───────────────────────────────────────────────

/**
 * Typed shape of the assistant's akm config.json. This replaces the nested
 * `as Record<string, unknown>` casts that used to hand-manipulate the JSON in
 * performSetup. Every field is optional because we merge over whatever the
 * operator (or a prior run) already wrote — extra/unknown keys are preserved
 * verbatim via the index signature.
 */
export type AkmLlmProfile = {
  endpoint: string;
  model: string;
  provider: string;
  [key: string]: unknown;
};

export type AkmEmbeddingConfig = {
  endpoint: string;
  model: string;
  provider: string;
  dimension: number;
  [key: string]: unknown;
};

export type AkmConfig = {
  profiles?: { llm?: Record<string, AkmLlmProfile>; [key: string]: unknown };
  defaults?: { llm?: string; [key: string]: unknown };
  embedding?: AkmEmbeddingConfig;
  stashDir?: string;
  /** Legacy 0.7 top-level key — read for migration awareness, never persisted. */
  llm?: unknown;
  [key: string]: unknown;
};

/**
 * Merge the setup wizard's LLM + embedding selections into the assistant's
 * akm config.json (atomic write). Existing operator keys — sibling profiles,
 * `sources`, custom fields — are preserved. No-op when neither llm nor
 * embedding is supplied.
 *
 * Writes the CANONICAL akm 0.8.0 shape: profiles.llm.default + defaults.llm.
 * The runtime resolver reads profiles.llm[defaults.llm] (akm config.ts).
 * Do NOT write a top-level `llm` — akm's top-level schema is .strict() with no
 * `llm` key (config-schema.ts AkmConfigShape). A top-level `llm` only loads
 * today via akm's legacy 0.7→0.8 migration shim (config-migration.ts), which
 * rewrites the file on load and is marked for removal — writing the native
 * shape removes that dependency, so any pre-existing legacy key is dropped.
 */
export function persistAkmConfig(
  state: ControlPlaneState,
  opts: { llm?: SetupSpec["llm"]; embedding?: SetupSpec["embedding"] },
): void {
  const { llm, embedding } = opts;
  if (!llm && !embedding) return;

  const akmConfigDir = join(state.configDir, "akm");
  mkdirSync(akmConfigDir, { recursive: true });
  const akmConfigPath = join(akmConfigDir, "config.json");

  let existing: AkmConfig = {};
  if (existsSync(akmConfigPath)) {
    try {
      existing = JSON.parse(readFileSync(akmConfigPath, "utf-8")) as AkmConfig;
    } catch {
      /* ignore corrupt */
    }
  }
  const updated: AkmConfig = { ...existing };

  if (llm) {
    const profiles = updated.profiles ?? {};
    const llmProfiles = profiles.llm ?? {};
    llmProfiles.default = {
      ...(llmProfiles.default ?? {}),
      endpoint: buildAkmEndpoint(llm.provider, llm.baseUrl, "/chat/completions"),
      model: llm.model,
      provider: llm.provider,
    };
    profiles.llm = llmProfiles;
    updated.profiles = profiles;
    const defaults = updated.defaults ?? {};
    if (typeof defaults.llm !== "string") defaults.llm = "default";
    updated.defaults = defaults;
    delete updated.llm; // never persist the legacy key
  }

  if (embedding) {
    updated.embedding = {
      ...(existing.embedding ?? {}),
      endpoint: buildAkmEndpoint(embedding.provider, embedding.baseUrl, "/embeddings"),
      model: embedding.model,
      provider: embedding.provider,
      dimension: embedding.dims,
    };
  }

  // The assistant's primary stash is ALWAYS /stash (the bind mount). Pin it in
  // config so it is explicit and operator-edits can't repoint it; the UI does
  // not expose stashDir. (The host task-runner still uses its own
  // AKM_STASH_DIR env, which takes precedence over config.stashDir.)
  updated.stashDir = "/stash";
  writeFileAtomic(akmConfigPath, JSON.stringify(updated, null, 2), 0o600);
}

/**
 * Persist portal (discord/slack/…) credentials into the vault secrets env.
 * Credential values come ONLY from the setup spec. PR #564 second retest P1-3:
 * the previous host-process-env fallback silently consumed ambient variables
 * (e.g. a leftover `DISCORD_BOT_TOKEN` in the operator's shell) as operator
 * input, overwriting an existing secret BEFORE keep-existing semantics could
 * preserve it. Omitting a credential now leaves the persisted secret untouched
 * — updateSecretsEnv only writes the keys explicitly supplied.
 */
function persistPortalCredentials(
  state: ControlPlaneState,
  portalCredentials?: Record<string, Record<string, string>>,
): void {
  const portalSecretUpdates = portalCredentials
    ? buildPortalCredentialEnvVars(portalCredentials)
    : {};
  updateSecretsEnv(state, portalSecretUpdates);
}

/**
 * Seed the default automation (akm-improve) into the AKM stash. Idempotent —
 * an existing file is left untouched so operator edits survive re-install and
 * upgrade. A no-op (with a warning) when the automation is missing from the
 * registry.
 */
export function seedDefaultAutomation(state: ControlPlaneState): void {
  const tasksDir = join(state.stashDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const akmImproveDest = join(tasksDir, "akm-improve.yml");
  if (existsSync(akmImproveDest)) return;
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

// ── Core Setup Orchestration ─────────────────────────────────────────────

export async function performSetup(
  input: SetupSpec,
  opts?: { state?: ControlPlaneState }
): Promise<SetupResult> {
  const validation = validateSetupSpec(input);
  if (!validation.valid) return { ok: false, error: validation.errors.join("; ") };

  const { llm, embedding, security, owner, connections, portalCredentials, addons, voiceProfile, ollamaProfile, imageTag, hostAkm, access } = input;
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
      updateSecretsEnv(state, updates);
      persistPortalCredentials(state, portalCredentials);
      // PR #564 P1-1: only write the UI login password when the operator
      // actually supplied one. An unchanged rerun omits it — preserve the
      // existing secret rather than rotating it to a value the operator never
      // saw (which would lock them out). Fail closed if there is nothing to
      // preserve (a fresh install must supply a password).
      if (security.uiLoginPassword) {
        patchSecretsEnvFile(state.homeDir, { OP_UI_LOGIN_PASSWORD: security.uiLoginPassword });
      } else if (!readSecret(state.homeDir, "op_ui_login_password")?.trim()) {
        throw new Error("security.uiLoginPassword is required — no existing UI login password to preserve.");
      }
      // Network access toggles. Absent `access` means "leave whatever is in
      // stack.env untouched": a rerun over a hand-tuned env, or over a
      // previous choice, never silently rewrites it unless the operator
      // actively set toggles this run.
      if (access) {
        const toggles = coerceAccessToggles(access);
        const patches: Record<string, string> = { ...resolveAccessEnv(toggles) };
        // Publishing the assistant API always turns auth on, with a key the
        // system GENERATES. The operator is never asked to invent one: the
        // human-facing credential is the UI login password in every
        // configuration, and this key is copy-pasted into another app.
        // Preserved across reruns — rotating it would break every client that
        // already holds it.
        if (
          requiresAssistantKey(toggles)
          && !readSecret(state.homeDir, "op_opencode_password")?.trim()
        ) {
          patches.OP_OPENCODE_PASSWORD = randomHex(24);
        }
        patchSecretsEnvFile(state.homeDir, patches);
      }
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
      // Reconcile the per-image version pins on EVERY setup run. A non-empty
      // wizard value pins each platform service image to that exact tag —
      // kept verbatim, "latest" included, as an explicit opt-in.
      // state/stack.env is the SOLE pin location (never the legacy
      // — writeVersions() writes there exclusively.
      //
      // A BLANK Advanced field means "track this CLI's own default", which is
      // now PLATFORM_VERSION (E1) rather than the moving `latest` tag — two
      // installs from the same CLI build should run the SAME recorded image,
      // not whatever `latest` happens to resolve to on their respective boot
      // days. Guarded by dockerManifestExists: a host-only ("unit=platform")
      // release publishes no matching service image tag, so pinning blindly
      // would strand that install on a 404 on first pull — fall back to
      // `latest` when the pinned tag isn't actually published. Honor
      // OP_IMAGE_NAMESPACE rather than hardcoding "openpalm/", matching every
      // other image-ref computation in the control plane (see
      // addon-availability.ts's voiceImageRef).
      //
      // Voice is EXCLUDED from the pin: its tags are `latest-cpu` /
      // `vX.Y.Z-cu121` (GPU-variant suffixed), not platform semver, so a bare
      // PLATFORM_VERSION pin would resolve to a nonexistent
      // `openpalm/voice:0.13.0`. It keeps tracking `latest` until explicitly
      // pinned by the operator.
      const akmUpdates: Record<string, string> = {};
      const trimmedTag = imageTag?.trim();
      if (trimmedTag) {
        for (const key of SERVICE_VERSION_KEYS) {
          akmUpdates[key] = key === "OP_VOICE_VERSION" ? "latest" : trimmedTag;
        }
      } else {
        const namespace = process.env.OP_IMAGE_NAMESPACE?.trim() || "openpalm";
        // The pin guard does a `docker manifest inspect` network probe. Skip it
        // when compose preflight is skipped (tests / offline) — the same "no
        // docker I/O" signal used elsewhere — and fall back to the moving
        // `latest` tag rather than doing real registry I/O that can hang.
        const probePins = !process.env.OP_SKIP_COMPOSE_PREFLIGHT;
        for (const key of SERVICE_VERSION_KEYS) {
          // Voice is excluded from the semver pin (see block comment above): its
          // tags are GPU-variant suffixed, not platform semver.
          if (key === "OP_VOICE_VERSION") {
            akmUpdates[key] = "latest";
            continue;
          }
          // Probe EACH service image independently (Codex #2). Service images
          // are built and published per-image, so a given PLATFORM_VERSION tag
          // may exist for `assistant` but not yet for `guardian`/`portal` (or a
          // host-only release publishes none of them). Pinning every service
          // off a single `assistant` probe would strand whichever images lag
          // behind on a 404 at first pull. Fall back to `latest` per image.
          if (!probePins) {
            akmUpdates[key] = "latest";
            continue;
          }
          const image = SERVICE_IMAGE_FOR_VERSION_KEY[key];
          const pinnedRef = `${namespace}/${image}:${PLATFORM_VERSION}`;
          const pinPublished = await dockerManifestExists(pinnedRef);
          akmUpdates[key] = pinPublished ? PLATFORM_VERSION : "latest";
        }
      }
      // NOTE: host-akm sharing no longer repoints the container's primary stash
      // (the old OP_AKM_STASH/OP_AKM_CONFIG split-brain). The personal ~/akm is
      // wired as a read-write SECONDARY source — see configureHostAkmSharing()
      // below (Phase 4) and the host-akm.compose.yml overlay.
      writeVersions(state, akmUpdates);

      // Write akm config with LLM and embedding settings from setup — atomic.
      persistAkmConfig(state, { llm, embedding });

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

      // Enable/disable requested addons (portals like discord, slack, etc.).
      // PR #564 second retest R6: honor an EXPLICIT `false` as a disable — the
      // old `if (enabled)` skipped it, so `{discord:false}` left Discord enabled.
      // setAddonEnabled records explicit activation state and ensures portal
      // secret files (on enable) / clears the hardware-profile key (on disable).
      if (addons) {
        for (const [name, enabled] of Object.entries(addons)) {
          setAddonEnabled(state.homeDir, name, enabled === true, state);
        }
      }

      // The guardian service is profile-gated behind guardian-ingress addons,
      // so a bind address alone deploys no guardian at all. Publishing a front
      // door promises something reachable, so make it so.
      //
      // `guardianOpenaiApi` publishes the OpenAI-compatible edge specifically,
      // which is the `api` addon — publishing it without enabling it would map
      // a host port onto a container that was never deployed. The `api` portal
      // is an ordinary capability toggle now (it used to be pinned enabled,
      // which is why this only ever needed the generic fallback below).
      if (access?.guardianOpenaiApi) {
        const apiEnabled = addons?.api === true
          || (addons?.api !== false && listEnabledAddonIds(state.homeDir).includes("api"));
        if (!apiEnabled) {
          setAddonEnabled(state.homeDir, "api", true, state);
          logger.info("auto-enabled the api portal for a published OpenAI-compatible edge", {
            reason: "the published port has nothing behind it otherwise",
          });
        }
      }
      // Any other guardian ingress will do for the guardian's own front door;
      // when nothing provides one, enable the built-in chat portal (the only
      // credential-less guardian-ingress addon).
      if (access?.guardianNetwork) {
        const hasGuardianIngress = [
          ...Object.entries(addons ?? {}).filter(([, on]) => on).map(([name]) => name),
          ...listEnabledAddonIds(state.homeDir),
        ].some((a) => GUARDIAN_INGRESS_ADDON_IDS.includes(a));
        if (!hasGuardianIngress) {
          setAddonEnabled(state.homeDir, "chat", true, state);
          logger.info("auto-enabled the chat portal for a published guardian", {
            reason: "guardian ingress required for the front door to exist",
          });
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
      seedDefaultAutomation(state);

      // NOTE: OP_SETUP_COMPLETE is intentionally NOT written here. Writing it
      // before the Docker deploy succeeds would mark setup "complete" even
      // when containers fail to start, sending the user to a broken admin UI
      // with no path back to the wizard. The flag is now written by
      // setup-deploy.ts:startDeploy AFTER `compose up --wait` (§2.1's single
      // health gate) confirms every CORE service is healthy.
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
