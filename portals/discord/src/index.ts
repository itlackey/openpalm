import {
  BasePortal,
  createLogger,
  deliverBufferedAnswer,
  type DeliverySink,
  errMessage,
  readRequiredSecretFile,
} from '@openpalm/portal-sdk';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
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
import { streamTurn, DISCORD_SESSION_PREAMBLE, type PendingQuestion } from "./stream-render.ts";
import type { PermissionConfig, UserInfo } from "./types.ts";

const log = createLogger("portal-discord");

const MAX_MESSAGE_LENGTH = 2000;

export default class DiscordChannel extends BasePortal {
  readonly name = "discord";
  protected readonly maxMessageLength = MAX_MESSAGE_LENGTH;

  constructor() {
    super(log);
  }

  private client: Client | null = null;
  private permissions: PermissionConfig = loadPermissionConfig();
  private commandRegistry = buildCommandRegistry(
    parseCustomCommands(Bun.env.DISCORD_CUSTOM_COMMANDS),
  );

  /**
   * Thread IDs the bot is actively participating in (`activeThreads`, keyed by
   * threadId, and the TTL/prune logic live in BasePortal). Threads expire after
   * threadTtlMs of inactivity.
   */
  protected readonly threadTtlMs = (Number(Bun.env.DISCORD_THREAD_TTL_HOURS) || 24) * 3_600_000;

  /**
   * Forward timeout in ms. Default: 0 (no timeout).
   * When set, applied to guardian forwarding requests.
   */
  private forwardTimeoutMs = Number(Bun.env.DISCORD_FORWARD_TIMEOUT_MS) || 0;

  /**
   * Opt-in rich-UX streaming. When false (default), turns are buffered and the
   * full assistant reply is posted once complete. When true, thread turns render
   * live via the guardian /oc/* proxy with tool embeds + interactive permission
   * prompts.
   */
  private streamingEnabled = Bun.env.DISCORD_STREAMING === "true";

  /**
   * Pending interactive `question` per thread, so the user can answer by typing a
   * normal message in the thread (not only by clicking a button). Set by the
   * streaming renderer when a question is asked, cleared when answered/turn-ends.
   * (Session→thread mapping is now the GUARDIAN's job — it dedupes create per
   * sessionKey — so no client-side session cache is needed.)
   */
  private pendingQuestions = new Map<string, PendingQuestion>();

  /**
   * Session keys that have already received the one-time channel preamble (the
   * `question`-tool nudge prepended to the first prompt of a session). In-memory
   * only: a restart re-primes each live session once, which is harmless. Cleared
   * for a session on /clear so a fresh OpenCode session gets primed again.
   */
  private primedSessions = new Set<string>();

  get botToken(): string {
    return readRequiredSecretFile("DISCORD_BOT_TOKEN_FILE");
  }

  get applicationId(): string {
    return Bun.env.DISCORD_APPLICATION_ID ?? "";
  }

  start(): void {
    // Verify the principal secret and bind the health server (BasePortal),
    // then connect to the Discord Gateway.
    this.startServer();
    void this.connectGateway();
  }

  // ── Gateway Connection ──────────────────────────────────────────────────

  private async connectGateway(): Promise<void> {
    let botToken: string;
    try {
      botToken = this.botToken;
    } catch (err) {
      log.error("startup_error", { reason: err instanceof Error ? err.message : "DISCORD_BOT_TOKEN_FILE could not be read" });
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

    // discord.js emits Events.Error for WebSocket/shard errors. Without a
    // listener, the EventEmitter rethrows as an uncaught exception and kills the
    // process — log and keep the gateway alive so discord.js can auto-reconnect.
    this.client.on(Events.Error, (err) => {
      log.error("discord_client_error", { error: errMessage(err) });
    });
    this.client.once(Events.ClientReady, (c) => this.onReady(c));
    this.client.on(Events.MessageCreate, (msg) => void this.onMessage(msg));
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand()) {
        void this.onSlashCommand(interaction);
      }
    });

    await this.client.login(botToken);
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
        error: errMessage(error),
      });
    }
  }

  // ── Thread Tracking ────────────────────────────────────────────────────

  /** Check if a thread has recent activity (within TTL). */
  private isThreadActive(threadId: string): boolean {
    return this.isThreadKeyActive(threadId);
  }

  /** Mark a thread as active (update timestamp). Prunes stale entries. */
  private touchThread(threadId: string): void {
    this.touchThreadKey(threadId);
  }

  /** Stop tracking a thread (used by /clear). */
  private forgetThread(threadId: string): void {
    this.activeThreads.delete(threadId);
    this.primedSessions.delete(`discord:thread:${threadId}`);
  }

  // ── Message Handling ────────────────────────────────────────────────────

  private shouldRespond(message: Message): boolean {
    if (!this.client?.user) return false;
    const botId = this.client.user.id;

    // In a tracked thread with recent activity: always respond
    if (message.channel.isThread() && this.isThreadActive(message.channel.id)) {
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
    triggerMessage: Message,
  ): Promise<void> {
    // Rich-UX streaming path (opt-in, Stage 4). Renders deltas + tool embeds +
    // interactive permission prompts live via the guardian /oc/* proxy. The
    // conversationQueue's run() promise settles when streamTurn resolves at
    // turn-end (session idle), keeping per-sessionKey serialization intact.
    if (this.streamingEnabled) {
      const sessionKey = String(metadata.sessionKey ?? `discord:thread:${thread.id}`);
      // Prime the model with the question-tool nudge ONCE per session (first turn).
      const sessionPreamble = this.primedSessions.has(sessionKey) ? undefined : DISCORD_SESSION_PREAMBLE;
      this.primedSessions.add(sessionKey);
      try {
        await streamTurn({
          client: this.ocClient,
          userId: `discord:${userInfo.userId}`,
          requestingUserId: userInfo.userId,
          thread,
          sessionKey,
          text,
          sessionPreamble,
          subscribeEvents: () => this.eventHub.subscribe(`discord:${userInfo.userId}`),
          triggerMessage,
          setPendingQuestion: (pending) => {
            if (pending) this.pendingQuestions.set(thread.id, pending);
            else this.pendingQuestions.delete(thread.id);
          },
        });
        log.info("stream_completed", { userId: userInfo.userId, threadId: thread.id, sessionKey });
      } catch (error) {
        this.pendingQuestions.delete(thread.id);
        const errMsg = errMessage(error);
        log.error("stream_error", { error: errMsg, userId: userInfo.userId, sessionKey });
        await thread.send(`Error: ${errMsg}`).catch(() => {});
      }
      return;
    }

    const stopTyping = await this.sendTypingLoop(thread);

    const result = await deliverBufferedAnswer({
      forward: () => this.forward({ userId: `discord:${userInfo.userId}`, text, metadata }, undefined, this.forwardTimeoutMs || undefined),
      sink: { postChunk: (chunk) => thread.send(chunk) },
      maxLength: this.maxMessageLength,
      interChunkDelayMs: 300,
      onSettled: stopTyping,
    });
    if (result.ok) {
      log.info("message_completed", {
        userId: userInfo.userId,
        guildId: userInfo.guildId,
        threadId: thread.id,
        sessionKey: metadata.sessionKey,
      });
    } else {
      log.error("message_error", {
        error: result.error,
        userId: userInfo.userId,
        sessionKey: metadata.sessionKey,
      });
    }
  }

  /** Track processed message IDs to prevent duplicate processing from Discord gateway re-deliveries. */
  private processedMessages = new Set<string>();
  private readonly PROCESSED_MSG_TTL_MS = 60_000;

  private markProcessed(messageId: string): boolean {
    if (this.processedMessages.has(messageId)) return false;
    this.processedMessages.add(messageId);
    setTimeout(() => this.processedMessages.delete(messageId), this.PROCESSED_MSG_TTL_MS);
    return true;
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.content) return;
    if (!this.shouldRespond(message)) return;
    if (!this.markProcessed(message.id)) return;

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

    // If an interactive `question` is pending for this thread, route a free-text
    // reply to it (answer-by-typing) instead of starting a NEW turn — only the
    // requester may answer (the in-flight turn then resumes and streams).
    if (message.channel.isThread()) {
      const pending = this.pendingQuestions.get(message.channel.id);
      if (pending) {
        if (message.author.id !== pending.requestingUserId) return;
        // Route through the question's idempotent resolver (shared with the
        // buttons) — it replies, updates the prompt message, and clears pending.
        await pending.resolve(text).catch((err) =>
          log.warn("question_text_reply_failed", { error: String(err), threadId: (message.channel as ThreadChannel).id }),
        );
        return;
      }
    }

    try {
      let thread: ThreadChannel;
      if (message.channel.isThread()) {
        thread = message.channel as ThreadChannel;
      } else {
        const threadName = text.split("\n")[0].slice(0, 100).trim() || "Conversation";
        try {
          thread = await message.startThread({
            name: threadName,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
          });
        } catch (threadErr) {
          // Thread may already exist if Discord re-delivered the event
          if (message.thread) {
            thread = message.thread as ThreadChannel;
          } else {
            throw threadErr;
          }
        }
      }

      this.touchThread(thread.id);

      const sessionKey = `discord:thread:${thread.id}`;
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
          }, message);
        },
      });
    } catch (error) {
      const errMsg = errMessage(error);
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

    try {
      const permResult = checkPermissions(this.permissions, userInfo);
      if (!permResult.allowed) {
        await interaction.reply({
          content: "You do not have permission to use this bot.",
          flags: MessageFlags.Ephemeral,
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
    } catch (error) {
      // A throw here (e.g. an expired/already-acknowledged interaction:
      // DiscordAPIError 10062/40060) would otherwise become an unhandled
      // rejection — the InteractionCreate listener fires this fire-and-forget —
      // and crash the Bun process. Log and best-effort notify the user instead.
      const errMsg = errMessage(error);
      log.error("slash_command_error", {
        command: commandName,
        userId: userInfo.userId,
        guildId: userInfo.guildId,
        error: errMsg,
      });
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
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
    await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
  }

  private async handleHealthCommand(
    interaction: ChatInputCommandInteraction,
    userId: string,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
      await interaction.reply({ content: "Please provide a message.", flags: MessageFlags.Ephemeral });
      return;
    }

    const interactionThreadId = interaction.channel?.isThread() ? interaction.channel.id : null;
    const sessionKey = interactionThreadId?.trim()
      ? `discord:thread:${interactionThreadId}`
      : `discord:channel:${interaction.channelId}:user:${userInfo.userId}`;
    const isBusy = this.conversationQueue.isProcessing(sessionKey);
    const shouldQueue = forceQueue && isBusy;

    if (shouldQueue) {
      await interaction.reply({ content: "Queued. I will run that next.", flags: MessageFlags.Ephemeral });
    } else {
      await interaction.deferReply();
    }

    await this.conversationQueue.runOrQueue(sessionKey, {
      run: async () => {
        const sink: DeliverySink = shouldQueue
          ? { postChunk: (chunk) => interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral }) }
          : { postChunk: (chunk) => interaction.followUp(chunk), editChunk: (chunk) => interaction.editReply(chunk) };
        const result = await deliverBufferedAnswer({
          forward: () => this.forward({
            userId: `discord:${userInfo.userId}`,
            text,
            metadata: {
              guildId: userInfo.guildId,
              username: userInfo.username,
              command: commandName,
              channelId: interaction.channelId,
              sessionKey,
            },
          }, undefined, this.forwardTimeoutMs || undefined),
          sink,
          maxLength: this.maxMessageLength,
        });
        if (result.ok) {
          log.info("command_completed", {
            command: commandName,
            userId: userInfo.userId,
            guildId: userInfo.guildId,
            sessionKey,
          });
        } else {
          log.error("command_error", { command: commandName, error: result.error, sessionKey });
        }
      },
    });
  }

  private async handleClearCommand(
    interaction: ChatInputCommandInteraction,
    userInfo: UserInfo,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const clearThreadId = interaction.channel?.isThread() ? interaction.channel.id : null;
    const sessionKey = clearThreadId?.trim()
      ? `discord:thread:${clearThreadId}`
      : `discord:channel:${interaction.channelId}:user:${userInfo.userId}`;

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
      // A cleared session becomes a fresh OpenCode session → re-prime next turn.
      this.primedSessions.delete(sessionKey);

      // Stop tracking this thread so the bot won't auto-respond anymore
      if (interaction.channel?.isThread()) {
        this.forgetThread(interaction.channel.id);
      }

      await interaction.editReply(
        droppedQueued > 0 ? "Conversation cleared. Dropped queued follow-ups." : "Conversation cleared.",
      );
    } catch (error) {
      const errMsg = errMessage(error);
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

  // ── Discord Message Utilities ───────────────────────────────────────────

}
