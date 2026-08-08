import { json } from "@sveltejs/kit";
import { readStackEnv, readStackSecretEnv, listEnabledAddonIds, getAddonProfiles, annotateAddonProfileAvailability, getAddonProfileSelection, readAccessToggles } from "@openpalm/lib";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getState } from "$lib/server/state.js";
import { getUiLoginPassword, requireAdmin, getRequestId } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

// Returns the full set of pre-fill data for re-running the setup wizard.
// Requires session auth so secrets are only returned to authenticated operators.

// One entry of the akm 0.9 `engines` map. The map holds BOTH kinds, so this
// models either — `platform` is the agent-engine discriminator this reader
// checks for, and never reads beyond it.
interface AkmEngine {
  kind?: string;
  provider?: string;
  model?: string;
  endpoint?: string;
  platform?: string;
}

interface AkmConfig {
  engines?: Record<string, AkmEngine>;
  defaults?: { llmEngine?: string };
  embedding?: { provider?: string; model?: string; endpoint?: string; dimension?: number };
}

function readAkmConfig(configDir: string): AkmConfig {
  const path = join(configDir, "akm", "config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as AkmConfig;
  } catch {
    return {};
  }
}

/**
 * Resolve the wizard-prefill LLM connection from the akm 0.9 engines map:
 * engines[defaults.llmEngine ?? "default"], falling back to engines.default.
 * Returns undefined when no llm engine is configured.
 *
 * `kind` is REQUIRED by akm 0.9's own schema, but this reader is deliberately
 * lenient about it in exactly the same direction as the AKM tab's reader
 * (akm-config.ts): an entry counts as LLM unless it is explicitly
 * `kind: "agent"`. A hand-written config that omits `kind` therefore prefills
 * the wizard instead of silently reporting "no LLM configured" — the two
 * readers of this same file must not disagree about what an entry is.
 */
function isLlmEngine(entry: AkmEngine | undefined): entry is AkmEngine {
  return Boolean(entry) && entry?.kind !== "agent";
}

/**
 * Exported for unit tests — pure, no request context. The `_` prefix is
 * required: SvelteKit only permits HTTP verb handlers and a fixed set of
 * reserved names as `+server.ts` exports, and rejects anything else at BUILD
 * time (neither svelte-check nor vitest enforces it). Same convention as
 * `_resetStatsCacheForTests` in api/host/akm/stats.
 */
export function _resolveDefaultLlmEngine(akm: AkmConfig): AkmEngine | undefined {
  const engines = akm.engines;
  if (!engines || typeof engines !== "object") return undefined;
  const preferred = engines[akm.defaults?.llmEngine ?? "default"];
  if (isLlmEngine(preferred)) return preferred;
  const fallback = engines.default;
  if (isLlmEngine(fallback)) return fallback;
  return undefined;
}

/**
 * Read model preferences persisted by importHostOpenCode into
 * <configDir>/assistant/opencode.json. This is the on-disk source of truth
 * after a host import; reusing it means wizard reruns restore the same
 * preferences without re-detecting the (possibly absent) host install.
 * Returns undefined if the file doesn't exist or contains no model keys.
 */
function readPersistedModelPreferences(
  configDir: string
): { model?: string; small_model?: string } | undefined {
  // assistantConfigDir(state) === state.configDir + "/assistant"
  const path = join(configDir, "assistant", "opencode.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const prefs: { model?: string; small_model?: string } = {};
    if (typeof parsed.model === "string" && parsed.model) prefs.model = parsed.model;
    if (typeof parsed.small_model === "string" && parsed.small_model) prefs.small_model = parsed.small_model;
    return prefs.model || prefs.small_model ? prefs : undefined;
  } catch {
    return undefined;
  }
}

// Derive a baseUrl from the akm config endpoint by stripping the well-known
// suffixes (`/chat/completions`, `/embeddings`). Lets the wizard reuse the
// same baseUrl shape connections were created with.
function deriveBaseUrl(endpoint: string | undefined): string {
  if (!endpoint) return "";
  return endpoint
    .replace(/\/chat\/completions\/?$/, "")
    .replace(/\/embeddings\/?$/, "")
    .replace(/\/+$/, "");
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const configured = getUiLoginPassword();

  const env = readStackEnv(state.homeDir);
  const secretEnv = readStackSecretEnv(state.homeDir);
  const akm = readAkmConfig(state.configDir);
  const akmLlm = _resolveDefaultLlmEngine(akm);
  const importedModelPreferences = readPersistedModelPreferences(state.configDir);

  // Addon hardware profiles (CPU / CUDA / …)
  const rawVoiceProfiles = getAddonProfiles(state.homeDir, 'voice');
  const voiceProfiles = await annotateAddonProfileAvailability(rawVoiceProfiles);
  const selectedVoiceProfile = getAddonProfileSelection(state.homeDir, 'voice');
  const rawOllamaProfiles = getAddonProfiles(state.homeDir, 'ollama');
  const ollamaProfiles = await annotateAddonProfileAvailability(rawOllamaProfiles);
  const selectedOllamaProfile = getAddonProfileSelection(state.homeDir, 'ollama');

  const hostHome = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const hostAkm =
    !!hostHome &&
    env.OP_AKM_STASH === `${hostHome}/akm` &&
    env.OP_AKM_CONFIG === `${hostHome}/.config/akm`;

  const meta = (envKey: string) => ({ envKey, present: Boolean(secretEnv[envKey]) });
  const discord: Record<string, { envKey: string; present: boolean }> = {};
  for (const [field, envKey] of Object.entries({
    botToken: 'DISCORD_BOT_TOKEN',
    applicationId: 'DISCORD_APPLICATION_ID',
    registerCommands: 'DISCORD_REGISTER_COMMANDS',
    allowedGuilds: 'DISCORD_ALLOWED_GUILDS',
    allowedRoles: 'DISCORD_ALLOWED_ROLES',
    allowedUsers: 'DISCORD_ALLOWED_USERS',
    blockedUsers: 'DISCORD_BLOCKED_USERS',
  })) {
    if (secretEnv[envKey]) discord[field] = meta(envKey);
  }

  const slack: Record<string, { envKey: string; present: boolean }> = {};
  for (const [field, envKey] of Object.entries({
    slackBotToken: 'SLACK_BOT_TOKEN',
    slackAppToken: 'SLACK_APP_TOKEN',
    allowedChannels: 'SLACK_ALLOWED_CHANNELS',
    allowedUsers: 'SLACK_ALLOWED_USERS',
    blockedUsers: 'SLACK_BLOCKED_USERS',
  })) {
    if (secretEnv[envKey]) slack[field] = meta(envKey);
  }

  const portalCredentials: Record<string, Record<string, { envKey: string; present: boolean }>> = {};
  if (Object.keys(discord).length > 0) portalCredentials.discord = discord;
  if (Object.keys(slack).length > 0) portalCredentials.slack = slack;

  return json({
    ok: true,
    // S3: Never return the plaintext password. The wizard rerun path checks
    // whether a password is set so it can show the field as pre-filled.
    hasPassword: typeof configured === "string" && configured.length > 0,
    assistantVersion: env.OP_ASSISTANT_VERSION ?? "",
    guardianVersion: env.OP_GUARDIAN_VERSION ?? "",
    portalVersion: env.OP_PORTAL_VERSION ?? "",
    voiceVersion: env.OP_VOICE_VERSION ?? "",
    hostAkm,
    llm: akmLlm ? {
      provider: akmLlm.provider ?? "",
      model: akmLlm.model ?? "",
      baseUrl: deriveBaseUrl(akmLlm.endpoint),
    } : null,
    embedding: akm.embedding ? {
      provider: akm.embedding.provider ?? "",
      model: akm.embedding.model ?? "",
      dims: akm.embedding.dimension ?? 0,
      baseUrl: deriveBaseUrl(akm.embedding.endpoint),
    } : null,
    // TTS/STT provider choice is client-owned (per-browser) now — the host
    // only reports the voice addon's hardware profiles + selection.
    voice: {
      profiles: voiceProfiles,
      selectedProfile: selectedVoiceProfile,
    },
    ollama: {
      profiles: ollamaProfiles,
      selectedProfile: selectedOllamaProfile,
    },
    enabledAddons: listEnabledAddonIds(state.homeDir),
    portalCredentials,
    importedModelPreferences: importedModelPreferences ?? null,
    // Current access toggles, for wizard rerun pre-fill. A direct read of the
    // generated binds — not an inference, so it can never report "custom".
    // (D7/D8); null means custom/hand-tuned, never a secret value (S3).
    access: readAccessToggles(env),
  });
};
