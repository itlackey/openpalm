import { buildChannelMessage, createLogger, forwardChannelMessage } from "@openpalm/channels-sdk";
import { findCommand, resolvePromptTemplate } from "./commands.ts";
import { editOriginalResponse } from "./discord-api.ts";
import { checkPermissions, extractIdentifiers } from "./permissions.ts";
import {
  InteractionType,
  InteractionResponseType,
  MessageFlags,
  type DiscordEmbed,
  type DiscordInteraction,
  type InteractionResponse,
  type CustomCommandDef,
  type PermissionConfig,
} from "./types.ts";

const log = createLogger("channel-discord");

const EMBED_COLOR_SUCCESS = 0x57f287;
const EMBED_COLOR_ERROR = 0xed4245;
const EMBED_COLOR_INFO = 0x5865f2;
const EMBED_COLOR_WARN = 0xfee75c;
const MAX_CONTENT_LENGTH = 2000;
const MAX_EMBED_DESCRIPTION = 4096;

export type InteractionDeps = {
  guardianUrl: string;
  sharedSecret: string;
  applicationId: string;
  commands: CustomCommandDef[];
  permissions: PermissionConfig;
  forwardFetch: typeof fetch;
};

function infoEmbed(title: string, description: string, fields?: DiscordEmbed["fields"]): DiscordEmbed {
  return { title, description, color: EMBED_COLOR_INFO, fields, timestamp: new Date().toISOString() };
}

function errorEmbed(description: string): DiscordEmbed {
  return { title: "Error", description, color: EMBED_COLOR_ERROR, timestamp: new Date().toISOString() };
}

function successEmbed(title: string, description: string): DiscordEmbed {
  return { title, description, color: EMBED_COLOR_SUCCESS, timestamp: new Date().toISOString() };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 30)}\n\n*[Response truncated]*`;
}

function immediateResponse(data: InteractionResponse["data"]): InteractionResponse {
  return { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data };
}

function deferredResponse(ephemeral = false): InteractionResponse {
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    ...(ephemeral ? { data: { flags: MessageFlags.EPHEMERAL } } : {}),
  };
}

function ephemeralEmbed(embed: DiscordEmbed): InteractionResponse {
  return immediateResponse({ embeds: [embed], flags: MessageFlags.EPHEMERAL });
}

function handleHelp(commands: CustomCommandDef[]): InteractionResponse {
  const builtinFields = [
    { name: "`/ask <message>`", value: "Send a message to the assistant", inline: false },
    { name: "`/health`", value: "Check the assistant's health status", inline: false },
    { name: "`/help`", value: "Show this help message", inline: false },
    { name: "`/clear`", value: "Start a fresh conversation", inline: false },
  ];

  const customFields = commands
    .filter((c) => !["ask", "health", "help", "clear"].includes(c.name))
    .map((c) => {
      const optStr = c.options?.map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`)).join(" ") ?? "";
      return { name: `\`/${c.name}${optStr ? ` ${optStr}` : ""}\``, value: c.description, inline: false };
    });

  const embed = infoEmbed("OpenPalm Assistant", "Available commands for interacting with your assistant:", [
    ...builtinFields,
    ...customFields,
  ]);

  return ephemeralEmbed(embed);
}

function handleClear(): InteractionResponse {
  const embed = successEmbed("Session Cleared", "Your conversation context has been reset. Start a new conversation with `/ask`.");
  return ephemeralEmbed(embed);
}

async function handleHealth(deps: InteractionDeps, userId: string): Promise<InteractionResponse> {
  const payload = buildChannelMessage({
    userId,
    channel: "discord",
    text: "health check",
    metadata: { command: "health" },
  });

  try {
    const resp = await forwardChannelMessage(deps.guardianUrl, deps.sharedSecret, payload, deps.forwardFetch);

    if (resp.ok) {
      const embed = successEmbed("System Health", "All systems operational. The assistant is ready to receive messages.");
      return ephemeralEmbed(embed);
    }

    const embed: DiscordEmbed = {
      title: "System Health",
      description: `The assistant returned status ${resp.status}. It may be temporarily unavailable.`,
      color: EMBED_COLOR_WARN,
      timestamp: new Date().toISOString(),
    };
    return ephemeralEmbed(embed);
  } catch {
    return ephemeralEmbed(errorEmbed("Unable to reach the assistant. Please try again later."));
  }
}

async function handleAssistantQuery(
  deps: InteractionDeps,
  interaction: DiscordInteraction,
  commandDef: CustomCommandDef | undefined,
): Promise<InteractionResponse> {
  const { userId, guildId, username } = extractIdentifiers(interaction);

  const optionValues: Record<string, string> = {};
  for (const opt of interaction.data?.options ?? []) {
    if (opt.value !== undefined) {
      optionValues[opt.name] = String(opt.value);
    }
  }

  let text: string;
  if (commandDef?.promptTemplate) {
    text = resolvePromptTemplate(commandDef.promptTemplate, optionValues);
  } else {
    text = optionValues.message ?? optionValues[Object.keys(optionValues)[0] ?? ""] ?? interaction.data?.name ?? "";
  }

  if (!text.trim()) {
    return ephemeralEmbed(errorEmbed("No message provided. Please include a message with your command."));
  }

  const commandName = interaction.data?.name ?? "ask";
  const isEphemeral = commandDef?.ephemeral ?? false;
  const deferred = deferredResponse(isEphemeral);

  void (async () => {
    const applicationId = interaction.application_id ?? deps.applicationId;
    const interactionToken = interaction.token ?? "";

    if (!interactionToken) {
      log.error("missing_interaction_token", { commandName });
      return;
    }

    const payload = buildChannelMessage({
      userId: `discord:${userId}`,
      channel: "discord",
      text,
      metadata: {
        channelId: interaction.channel_id,
        guildId,
        username,
        command: commandName,
      },
    });

    try {
      const resp = await forwardChannelMessage(deps.guardianUrl, deps.sharedSecret, payload, deps.forwardFetch);

      if (!resp.ok) {
        log.error("gateway_error", { commandName, status: resp.status });
        await editOriginalResponse(applicationId, interactionToken, {
          embeds: [errorEmbed("The assistant encountered an error processing your request. Please try again.")],
        });
        return;
      }

      const result = (await resp.json()) as { answer?: string };
      const answer = result.answer ?? "No response received.";

      if (answer.length > MAX_CONTENT_LENGTH) {
        await editOriginalResponse(applicationId, interactionToken, {
          embeds: [{
            description: truncate(answer, MAX_EMBED_DESCRIPTION),
            color: EMBED_COLOR_INFO,
            footer: { text: `/${commandName}` },
            timestamp: new Date().toISOString(),
          }],
        });
      } else {
        await editOriginalResponse(applicationId, interactionToken, { content: answer });
      }

      log.info("command_completed", { commandName, userId, guildId });
    } catch (error) {
      log.error("command_error", {
        commandName,
        error: error instanceof Error ? error.message : String(error),
      });
      await editOriginalResponse(applicationId, interactionToken, {
        embeds: [errorEmbed("An unexpected error occurred. Please try again later.")],
      });
    }
  })();

  return deferred;
}

export async function handleInteraction(interaction: DiscordInteraction, deps: InteractionDeps): Promise<InteractionResponse> {
  if (interaction.type === InteractionType.PING) {
    return { type: InteractionResponseType.PONG };
  }

  const permResult = checkPermissions(deps.permissions, interaction);
  if (!permResult.allowed) {
    return ephemeralEmbed(
      errorEmbed("You do not have permission to use this bot. Contact your server administrator."),
    );
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const commandName = interaction.data?.name ?? "";
    const { userId, guildId } = extractIdentifiers(interaction);
    log.info("command_received", { command: commandName, userId, guildId });

    switch (commandName) {
      case "help":
        return handleHelp(deps.commands);
      case "clear":
        return handleClear();
      case "health":
        return await handleHealth(deps, `discord:${userId}`);
      case "ask":
      default: {
        const commandDef = findCommand(deps.commands, commandName);
        return await handleAssistantQuery(deps, interaction, commandDef);
      }
    }
  }

  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    return immediateResponse({
      content: "This button is no longer active.",
      flags: MessageFlags.EPHEMERAL,
    });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
    return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: {} };
  }

  log.warn("unknown_interaction_type", { type: interaction.type });
  return { type: InteractionResponseType.PONG };
}
