import { json } from "@sveltejs/kit";
import { readStackEnv, readStackSecretEnv, listEnabledAddonIds, getAddonProfiles, annotateAddonProfileAvailability, getAddonProfileSelection } from "@openpalm/lib";
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

  const env = readStackEnv(state.stackDir);
  const secretEnv = readStackSecretEnv(state.stackDir);
  const akm = readAkmConfig(state.configDir);

  // Addon hardware profiles (CPU / CUDA / …)
  const rawVoiceProfiles = getAddonProfiles(state.homeDir, 'voice');
  const voiceProfiles = await annotateAddonProfileAvailability(rawVoiceProfiles);
  const selectedVoiceProfile = getAddonProfileSelection(state.stackDir, 'voice');
  const rawOllamaProfiles = getAddonProfiles(state.homeDir, 'ollama');
  const ollamaProfiles = await annotateAddonProfileAvailability(rawOllamaProfiles);
  const selectedOllamaProfile = getAddonProfileSelection(state.stackDir, 'ollama');

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

  const channelCredentials: Record<string, Record<string, { envKey: string; present: boolean }>> = {};
  if (Object.keys(discord).length > 0) channelCredentials.discord = discord;
  if (Object.keys(slack).length > 0) channelCredentials.slack = slack;

  return json({
    ok: true,
    // S3: Never return the plaintext password. The wizard rerun path checks
    // whether a password is set so it can show the field as pre-filled.
    hasPassword: typeof configured === "string" && configured.length > 0,
    imageTag: env.OP_IMAGE_TAG ?? "",
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
    voice: {
      tts: {
        engine: env.OP_TTS_ENGINE ?? "",
        baseURL: env.OP_TTS_BASE_URL ?? "",
        model: env.OP_TTS_MODEL ?? "",
        voice: env.OP_TTS_VOICE ?? "",
      },
      stt: {
        engine: env.OP_STT_ENGINE ?? "",
        baseURL: env.OP_STT_BASE_URL ?? "",
        model: env.OP_STT_MODEL ?? "",
        language: env.OP_STT_LANGUAGE ?? "",
      },
      profiles: voiceProfiles,
      selectedProfile: selectedVoiceProfile,
    },
    ollama: {
      profiles: ollamaProfiles,
      selectedProfile: selectedOllamaProfile,
    },
    enabledAddons: listEnabledAddonIds(state.homeDir),
    channelCredentials,
  });
};
