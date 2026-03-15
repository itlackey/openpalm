import { BaseChannel, createLogger, splitMessage, type HandleResult } from "@openpalm/channels-sdk";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { buildCommandRegistry, parseCustomCommands, resolvePromptTemplate } from "./commands.ts";
import { checkPermissions, loadPermissionConfig } from "./permissions.ts";
import {
  buildThreadSessionKey,
  ConversationQueue,
  resolveInteractionSessionKey,
} from "./session.ts";
import type { PermissionConfig, UserInfo } from "./types.ts";

const log = createLogger("channel-discord");

const MAX_MESSAGE_LENGTH = 2000;

export default class DiscordChannel extends BaseChannel {
  name = "discord";

  private client: Client | null = null;
  private permissions: PermissionConfig = loadPermissionConfig();
  private commandRegistry = buildCommandRegistry(
    parseCustomCommands(Bun.env.DISCORD_CUSTOM_COMMANDS),
  );
  private conversationQueue = new ConversationQueue();

  /** Thread IDs the bot is actively participating in. */
  private activeThreads = new Set<string>();

  get botToken(): string {
    return Bun.env.DISCORD_BOT_TOKEN ?? "";
  }

  get applicationId(): string {
    return Bun.env.DISCORD_APPLICATION_ID ?? "";
  }

  /** BaseChannel requires this — not used for Gateway messages. */
  async handleRequest(_req: Request): Promise<HandleResult | null> {
    return null;
  }

  override start(): void {
    // Start HTTP server for health checks + guardian forwarding setup
    super.start();
    // Connect to Discord Gateway
    void this.connectGateway();
  }

  // ── Gateway Connection ──────────────────────────────────────────────────

  private async connectGateway(): Promise<void> {
    if (!this.botToken) {
      log.error("startup_error", { reason: "DISCORD_BOT_TOKEN not set" });
      process.exit(1);
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Message, Partials.Channel],
    });

    this.client.once(Events.ClientReady, (c) => this.onReady(c));
    this.client.on(Events.MessageCreate, (msg) => void this.onMessage(msg));
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand()) {
        void this.onSlashCommand(interaction);
      }
    });

    await this.client.login(this.botToken);
  }

  private onReady(client: Client<true>): void {
    log.info("gateway_connected", {
      tag: client.user.tag,
      guilds: client.guilds.cache.size,
    });

    if (this.applicationId && Bun.env.DISCORD_REGISTER_COMMANDS !== "false") {
      void this.registerSlashCommands();
    }
  }

  // ── Slash Command Registration ──────────────────────────────────────────

  private async registerSlashCommands(): Promise<void> {
    const rest = new REST().setToken(this.botToken);
    const payload = this.commandRegistry.registrationPayload;
    const allowedGuilds = this.permissions.allowedGuilds;

    try {
      if (allowedGuilds.size > 0) {
        for (const guildId of allowedGuilds) {
          await rest.put(
            Routes.applicationGuildCommands(this.applicationId, guildId),
            { body: payload },
          );
          log.info("commands_registered", {
            scope: `guild:${guildId}`,
            count: payload.length,
            commands: payload.map((c) => c.name),
          });
        }
      } else {
        await rest.put(
          Routes.applicationCommands(this.applicationId),
          { body: payload },
        );
        log.info("commands_registered", {
          scope: "global",
          count: payload.length,
          commands: payload.map((c) => c.name),
        });
      }
    } catch (error) {
      log.error("command_registration_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Message Handling ────────────────────────────────────────────────────

  private shouldRespond(message: Message): boolean {
    if (!this.client?.user) return false;
    const botId = this.client.user.id;

    // In a tracked thread: always respond
    if (message.channel.isThread() && this.activeThreads.has(message.channel.id)) {
      return true;
    }

    // Otherwise: only when mentioned
    return message.mentions.has(botId);
  }

  private cleanContent(message: Message): string {
    if (!this.client?.user) return message.content;
    const botId = this.client.user.id;
    return message.content
      .replace(new RegExp(`<@!?${botId}>`, "g"), "")
      .trim();
  }

  private extractUserInfo(message: Message): UserInfo {
    return {
      userId: message.author.id,
      guildId: message.guildId ?? "",
      roles: message.member?.roles.cache.map((r) => r.id) ?? [],
      username: message.author.username,
    };
  }

  private async sendTypingLoop(channel: ThreadChannel): Promise<() => void> {
    await channel.sendTyping();
    const typingInterval = setInterval(() => {
      channel.sendTyping().catch(() => {});
    }, 5000);

    return () => clearInterval(typingInterval);
  }

  private async runThreadConversation(
    thread: ThreadChannel,
    userInfo: UserInfo,
    text: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const stopTyping = await this.sendTypingLoop(thread);

    try {
      const answer = await this.forwardToGuardian(userInfo.userId, text, metadata);
      stopTyping();
      await this.sendSplitMessage(thread, answer);
      log.info("message_completed", {
        userId: userInfo.userId,
        guildId: userInfo.guildId,
        threadId: thread.id,
        sessionKey: metadata.sessionKey,
      });
    } catch (error) {
      stopTyping();
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error("message_error", {
        error: errMsg,
        userId: userInfo.userId,
        sessionKey: metadata.sessionKey,
      });
      await thread.send(`Error: ${errMsg}`);
    }
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.content) return;
    if (!this.shouldRespond(message)) return;

    const userInfo = this.extractUserInfo(message);
    const permResult = checkPermissions(this.permissions, userInfo);
    if (!permResult.allowed) {
      await message.reply("You do not have permission to use this bot.");
      return;
    }

    const text = this.cleanContent(message);
    if (!text.trim()) {
      await message.reply("Please provide a message.");
      return;
    }

    try {
      let thread: ThreadChannel;
      if (message.channel.isThread()) {
        thread = message.channel as ThreadChannel;
      } else {
        const threadName = text.split("\n")[0].slice(0, 100).trim() || "Conversation";
        thread = await message.startThread({
          name: threadName,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
        });
      }

      this.activeThreads.add(thread.id);

      const sessionKey = buildThreadSessionKey(thread.id);
      await this.conversationQueue.runOrQueue(sessionKey, {
        onQueued: async () => {
          if (message.channel.isThread()) {
            await thread.send("Queued. I will pick this up next.");
          }
        },
        run: async () => {
          await this.runThreadConversation(thread, userInfo, text, {
            guildId: userInfo.guildId,
            username: userInfo.username,
            channelId: message.channelId,
            sessionKey,
          });
        },
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error("thread_error", { error: errMsg });
      try {
        await message.reply(`Error: ${errMsg}`);
      } catch {
        // ignore reply errors
      }
    }
  }

  // ── Slash Command Handling ──────────────────────────────────────────────

  private extractInteractionUserInfo(interaction: ChatInputCommandInteraction): UserInfo {
    const roles: string[] = [];
    if (interaction.member) {
      if (interaction.member instanceof Object && "cache" in (interaction.member as GuildMember).roles) {
        roles.push(...(interaction.member as GuildMember).roles.cache.map((r) => r.id));
      } else if (Array.isArray((interaction.member as Record<string, unknown>).roles)) {
        roles.push(...((interaction.member as Record<string, unknown>).roles as string[]));
      }
    }
    return {
      userId: interaction.user.id,
      guildId: interaction.guildId ?? "",
      roles,
      username: interaction.user.username,
    };
  }

  private async onSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const commandName = interaction.commandName;
    const userInfo = this.extractInteractionUserInfo(interaction);

    log.info("command_received", {
      command: commandName,
      userId: userInfo.userId,
      guildId: userInfo.guildId,
    });

    const permResult = checkPermissions(this.permissions, userInfo);
    if (!permResult.allowed) {
      await interaction.reply({
        content: "You do not have permission to use this bot.",
        ephemeral: true,
      });
      return;
    }

    switch (commandName) {
      case "help":
        await this.handleHelpCommand(interaction);
        return;
      case "clear":
        await this.handleClearCommand(interaction, userInfo);
        return;
      case "queue":
        await this.handleAskCommand(interaction, commandName, userInfo, true);
        return;
      case "health":
        await this.handleHealthCommand(interaction, userInfo.userId);
        return;
      default:
        await this.handleAskCommand(interaction, commandName, userInfo);
        return;
    }
  }

  private async handleHelpCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const lines = ["**Available Commands:**\n"];
    for (const cmd of this.commandRegistry.all) {
      const opts = cmd.options
        ?.map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`))
        .join(" ") ?? "";
      lines.push(`\`/${cmd.name}${opts ? ` ${opts}` : ""}\` — ${cmd.description}`);
    }
    lines.push("\nYou can also mention me in any channel to start a conversation.");
    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
  }

  private async handleHealthCommand(
    interaction: ChatInputCommandInteraction,
    userId: string,
  ): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    try {
      const resp = await this.forward({
        userId: `discord:${userId}`,
        text: "health check",
        metadata: { command: "health" },
      });
      if (resp.ok) {
        await interaction.editReply("All systems operational.");
      } else {
        await interaction.editReply(
          `Assistant returned status ${resp.status}. It may be temporarily unavailable.`,
        );
      }
    } catch {
      await interaction.editReply("Unable to reach the assistant. Please try again later.");
    }
  }

  private async handleAskCommand(
    interaction: ChatInputCommandInteraction,
    commandName: string,
    userInfo: UserInfo,
    forceQueue = false,
  ): Promise<void> {
    const commandDef = this.commandRegistry.all.find((c) => c.name === commandName);
    const optionValues: Record<string, string> = {};
    for (const opt of interaction.options.data) {
      if (opt.value !== undefined) {
        optionValues[opt.name] = String(opt.value);
      }
    }

    let text: string;
    if (commandDef?.promptTemplate) {
      text = resolvePromptTemplate(commandDef.promptTemplate, optionValues);
    } else {
      text = optionValues.message ?? optionValues[Object.keys(optionValues)[0] ?? ""] ?? "";
    }

    if (!text.trim()) {
      await interaction.reply({ content: "Please provide a message.", ephemeral: true });
      return;
    }

    const sessionKey = resolveInteractionSessionKey({
      channelId: interaction.channelId,
      userId: userInfo.userId,
      threadId: interaction.channel?.isThread() ? interaction.channel.id : null,
    });
    const isBusy = this.conversationQueue.isProcessing(sessionKey);
    const shouldQueue = forceQueue && isBusy;

    if (shouldQueue) {
      await interaction.reply({ content: "Queued. I will run that next.", ephemeral: true });
    } else {
      await interaction.deferReply();
    }

    await this.conversationQueue.runOrQueue(sessionKey, {
      run: async () => {
        try {
          const answer = await this.forwardToGuardian(userInfo.userId, text, {
            guildId: userInfo.guildId,
            username: userInfo.username,
            command: commandName,
            channelId: interaction.channelId,
            sessionKey,
          });

          const chunks = splitMessage(answer, MAX_MESSAGE_LENGTH);

          if (shouldQueue) {
            await interaction.followUp({ content: chunks[0], ephemeral: true });
            for (let i = 1; i < chunks.length; i++) {
              await interaction.followUp({ content: chunks[i], ephemeral: true });
            }
          } else {
            await interaction.editReply(chunks[0]);
            for (let i = 1; i < chunks.length; i++) {
              await interaction.followUp(chunks[i]);
            }
          }

          log.info("command_completed", {
            command: commandName,
            userId: userInfo.userId,
            guildId: userInfo.guildId,
            sessionKey,
          });
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          log.error("command_error", { command: commandName, error: errMsg, sessionKey });
          if (shouldQueue) {
            await interaction.followUp({ content: `Error: ${errMsg}`, ephemeral: true });
          } else {
            await interaction.editReply(`Error: ${errMsg}`);
          }
        }
      },
    });
  }

  private async handleClearCommand(
    interaction: ChatInputCommandInteraction,
    userInfo: UserInfo,
  ): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const sessionKey = resolveInteractionSessionKey({
      channelId: interaction.channelId,
      userId: userInfo.userId,
      threadId: interaction.channel?.isThread() ? interaction.channel.id : null,
    });

    try {
      const resp = await this.forward({
        userId: `discord:${userInfo.userId}`,
        text: "clear session",
        metadata: {
          command: "clear",
          channelId: interaction.channelId,
          guildId: userInfo.guildId,
          username: userInfo.username,
          sessionKey,
          clearSession: true,
        },
      });

      if (!resp.ok) {
        await interaction.editReply("Could not clear this conversation right now.");
        return;
      }

      const droppedQueued = this.conversationQueue.clear(sessionKey);

      await interaction.editReply(
        droppedQueued > 0 ? "Conversation cleared. Dropped queued follow-ups." : "Conversation cleared.",
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error("clear_error", {
        error: errMsg,
        sessionKey,
        userId: userInfo.userId,
        guildId: userInfo.guildId,
        channelId: interaction.channelId,
      });
      await interaction.editReply("Could not clear this conversation right now.");
    }
  }

  // ── Guardian Forwarding ─────────────────────────────────────────────────

  private async forwardToGuardian(
    userId: string,
    text: string,
    metadata: Record<string, unknown>,
  ): Promise<string> {
    const resp = await this.forward({
      userId: `discord:${userId}`,
      text,
      metadata,
    });

    if (!resp.ok) {
      throw new Error(`Guardian returned status ${resp.status}`);
    }

    const result = (await resp.json()) as { answer?: string };
    return result.answer ?? "No response received.";
  }

  // ── Discord Message Utilities ───────────────────────────────────────────

  private async sendSplitMessage(channel: ThreadChannel, text: string): Promise<void> {
    const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      await channel.send(chunk);
      if (chunks.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
}
