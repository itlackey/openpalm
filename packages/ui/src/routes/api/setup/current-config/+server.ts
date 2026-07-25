import { json } from "@sveltejs/kit";
import { readStackEnv, readStackSecretEnv, listEnabledAddonIds, getAddonProfiles, annotateAddonProfileAvailability, getAddonProfileSelection, readAccessToggles } from "@openpalm/lib";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getState } from "$lib/server/state.js";
import { getUiLoginPassword, requireAdmin, getRequestId } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

// Returns the full set of pre-fill data for re-running the setup wizard.
// Requires session auth so secrets are only returned to authenticated operators.

interface AkmConfig {
  llm?: { provider?: string; model?: string; endpoint?: string };
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
    llm: akm.llm ? {
      provider: akm.llm.provider ?? "",
      model: akm.llm.model ?? "",
      baseUrl: deriveBaseUrl(akm.llm.endpoint),
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
    hasOpencodePassword: Boolean(secretEnv.OP_OPENCODE_PASSWORD),
  });
};
