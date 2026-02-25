/**
 * Minimal Discord REST API client.
 *
 * Handles command registration and interaction follow-ups. Uses native fetch
 * with no external dependencies, consistent with the project's lightweight approach.
 */

import { log } from "./logger.ts";

const DISCORD_API_BASE = "https://discord.com/api/v10";

export type DiscordApiConfig = {
  applicationId: string;
  botToken: string;
};

type SlashCommandPayload = {
  name: string;
  description: string;
  type?: number;
  options?: Array<{
    name: string;
    description: string;
    type: number;
    required?: boolean;
    choices?: Array<{ name: string; value: string }>;
  }>;
};

/**
 * Register slash commands globally or to a specific guild.
 * Uses bulk overwrite (PUT) which replaces all existing commands.
 */
export async function registerCommands(
  config: DiscordApiConfig,
  commands: SlashCommandPayload[],
  guildId?: string,
): Promise<boolean> {
  const url = guildId
    ? `${DISCORD_API_BASE}/applications/${config.applicationId}/guilds/${guildId}/commands`
    : `${DISCORD_API_BASE}/applications/${config.applicationId}/commands`;

  const scope = guildId ? `guild:${guildId}` : "global";

  try {
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bot ${config.botToken}`,
      },
      body: JSON.stringify(commands),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log.error("command_registration_failed", {
        scope,
        status: resp.status,
        body: body.slice(0, 500),
      });
      return false;
    }

    const registered = (await resp.json()) as Array<{ name: string }>;
    log.info("commands_registered", {
      scope,
      count: registered.length,
      commands: registered.map((c) => c.name),
    });
    return true;
  } catch (error) {
    log.error("command_registration_error", {
      scope,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Edit the original deferred interaction response.
 * Used after sending a DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (type 5).
 */
export async function editOriginalResponse(
  applicationId: string,
  interactionToken: string,
  payload: {
    content?: string;
    embeds?: Array<Record<string, unknown>>;
    components?: Array<Record<string, unknown>>;
  },
): Promise<boolean> {
  const url = `${DISCORD_API_BASE}/webhooks/${applicationId}/${interactionToken}/messages/@original`;

  try {
    const resp = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log.error("edit_response_failed", { status: resp.status, body: body.slice(0, 500) });
      return false;
    }

    return true;
  } catch (error) {
    log.error("edit_response_error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Send a follow-up message to an interaction.
 */
export async function sendFollowUp(
  applicationId: string,
  interactionToken: string,
  payload: {
    content?: string;
    embeds?: Array<Record<string, unknown>>;
    components?: Array<Record<string, unknown>>;
    flags?: number;
  },
): Promise<boolean> {
  const url = `${DISCORD_API_BASE}/webhooks/${applicationId}/${interactionToken}`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log.error("follow_up_failed", { status: resp.status, body: body.slice(0, 500) });
      return false;
    }

    return true;
  } catch (error) {
    log.error("follow_up_error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
