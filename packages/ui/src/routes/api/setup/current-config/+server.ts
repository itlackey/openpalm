import { json } from "@sveltejs/kit";
import { readStackEnv, listEnabledAddonIds } from "@openpalm/lib";
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

export const GET: RequestHandler = (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const configured = getUiLoginPassword();

  const env = readStackEnv(state.stackDir);
  const akm = readAkmConfig(state.configDir);

  const hostHome = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const hostAkm =
    !!hostHome &&
    env.OP_AKM_STASH === `${hostHome}/akm` &&
    env.OP_AKM_CONFIG === `${hostHome}/.config/akm`;

  // Channel credentials currently saved in stack.env. Mirror the inverse of
  // CHANNEL_CREDENTIAL_ENV_MAP in setup.ts.
  const discord: Record<string, string> = {};
  if (env.DISCORD_BOT_TOKEN) discord.botToken = env.DISCORD_BOT_TOKEN;
  if (env.DISCORD_APPLICATION_ID) discord.applicationId = env.DISCORD_APPLICATION_ID;
  if (env.DISCORD_ALLOWED_GUILDS) discord.allowedGuilds = env.DISCORD_ALLOWED_GUILDS;
  if (env.DISCORD_ALLOWED_ROLES) discord.allowedRoles = env.DISCORD_ALLOWED_ROLES;
  if (env.DISCORD_ALLOWED_USERS) discord.allowedUsers = env.DISCORD_ALLOWED_USERS;
  if (env.DISCORD_BLOCKED_USERS) discord.blockedUsers = env.DISCORD_BLOCKED_USERS;
  if (env.DISCORD_REGISTER_COMMANDS) discord.registerCommands = env.DISCORD_REGISTER_COMMANDS;

  const slack: Record<string, string> = {};
  if (env.SLACK_BOT_TOKEN) slack.slackBotToken = env.SLACK_BOT_TOKEN;
  if (env.SLACK_APP_TOKEN) slack.slackAppToken = env.SLACK_APP_TOKEN;
  if (env.SLACK_ALLOWED_CHANNELS) slack.allowedChannels = env.SLACK_ALLOWED_CHANNELS;
  if (env.SLACK_ALLOWED_USERS) slack.allowedUsers = env.SLACK_ALLOWED_USERS;
  if (env.SLACK_BLOCKED_USERS) slack.blockedUsers = env.SLACK_BLOCKED_USERS;

  const channelCredentials: Record<string, Record<string, string>> = {};
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
        baseURL: env.OP_TTS_BASE_URL ?? "",
        model: env.OP_TTS_MODEL ?? "",
        voice: env.OP_TTS_VOICE ?? "",
      },
      stt: {
        baseURL: env.OP_STT_BASE_URL ?? "",
        model: env.OP_STT_MODEL ?? "",
        language: env.OP_STT_LANGUAGE ?? "",
      },
    },
    enabledAddons: listEnabledAddonIds(state.homeDir),
    channelCredentials,
  });
};
