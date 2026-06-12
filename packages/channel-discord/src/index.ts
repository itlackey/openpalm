import { BaseChannel, ConversationQueue, createLogger, readRequiredSecretFile, splitMessage, type HandleResult } from "@openpalm/channels-sdk";
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
import { OcClient } from "@openpalm/channels-sdk";
import { buildCommandRegistry, parseCustomCommands, resolvePromptTemplate } from "./commands.ts";
import { checkPermissions, loadPermissionConfig } from "./permissions.ts";
import { streamTurn, DISCORD_SESSION_PREAMBLE, type PendingQuestion } from "./stream-render.ts";
import { OcEventHub } from "./oc-event-hub.ts";
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

  /**
   * Thread IDs the bot is actively participating in.
   * Map of threadId → last activity timestamp (ms).
   * Threads expire after threadTtlMs of inactivity.
   */
  private activeThreads = new Map<string, number>();

  /** Thread inactivity TTL in ms. Default: 24 hours. */
  private threadTtlMs = (Number(Bun.env.DISCORD_THREAD_TTL_HOURS) || 24) * 3_600_000;

  /**
   * Forward timeout in ms. Default: 0 (no timeout).
   * When set, applied to guardian forwarding requests.
   */
  private forwardTimeoutMs = Number(Bun.env.DISCORD_FORWARD_TIMEOUT_MS) || 0;

  /**
   * Opt-in rich-UX streaming (design Stage 4). When false (default), the
   * buffered /channel/inbound path is used — byte-for-byte the legacy behavior
   * (§7). When true, thread turns render live via the guardian /oc/* proxy with
   * tool embeds + interactive permission prompts.
   */
  private streamingEnabled = Bun.env.DISCORD_STREAMING === "true";

  /** Lazily-built native OpenCode client through the guardian /oc/* proxy. */
  private ocClientInstance: OcClient | null = null;

  /**
   * One shared /event subscription per principal. Concurrent threads from the
   * same user fan out from a SINGLE upstream stream, so we never trip the
   * guardian's per-principal concurrent-stream cap (the /event stream is already
   * principal-scoped — opening one per thread was redundant).
   */
  private ocEventHubInstance: OcEventHub | null = null;

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

  private get ocClient(): OcClient {
    if (!this.ocClientInstance) {
      this.ocClientInstance = new OcClient({
        principalId: this.name,
        secret: this.secret,
        baseUrl: `${this.guardianUrl}/oc`,
      });
    }
    return this.ocClientInstance;
  }

  private get ocEventHub(): OcEventHub {
    if (!this.ocEventHubInstance) {
      this.ocEventHubInstance = new OcEventHub(this.ocClient);
    }
    return this.ocEventHubInstance;
  }

  get botToken(): string {
    return readRequiredSecretFile("DISCORD_BOT_TOKEN_FILE");
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
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Thread Tracking ────────────────────────────────────────────────────

  /** Check if a thread has recent activity (within TTL). */
  private isThreadActive(threadId: string): boolean {
    const lastActivity = this.activeThreads.get(threadId);
    if (lastActivity === undefined) return false;
    if (Date.now() - lastActivity > this.threadTtlMs) {
      this.activeThreads.delete(threadId);
      return false;
    }
    return true;
  }

  /** Mark a thread as active (update timestamp). Prunes stale entries. */
  private touchThread(threadId: string): void {
    this.activeThreads.set(threadId, Date.now());
    // Prune stale entries when map grows large
    if (this.activeThreads.size > 100) {
      const now = Date.now();
      for (const [id, ts] of this.activeThreads) {
        if (now - ts > this.threadTtlMs) {
          this.activeThreads.delete(id);
        }
      }
    }
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
          subscribeEvents: () => this.ocEventHub.subscribe(`discord:${userInfo.userId}`),
          triggerMessage,
          setPendingQuestion: (pending) => {
            if (pending) this.pendingQuestions.set(thread.id, pending);
            else this.pendingQuestions.delete(thread.id);
          },
        });
        log.info("stream_completed", { userId: userInfo.userId, threadId: thread.id, sessionKey });
      } catch (error) {
        this.pendingQuestions.delete(thread.id);
        const errMsg = error instanceof Error ? error.message : String(error);
        log.error("stream_error", { error: errMsg, userId: userInfo.userId, sessionKey });
        await thread.send(`Error: ${errMsg}`).catch(() => {});
      }
      return;
    }

    const stopTyping = await this.sendTypingLoop(thread);

    try {
      const resp = await this.forward({ userId: `discord:${userInfo.userId}`, text, metadata }, undefined, this.forwardTimeoutMs || undefined);
      if (!resp.ok) throw new Error(`Guardian returned status ${resp.status}`);
      const { answer = "No response received." } = await resp.json() as { answer?: string };
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

    const interactionThreadId = interaction.channel?.isThread() ? interaction.channel.id : null;
    const sessionKey = interactionThreadId?.trim()
      ? `discord:thread:${interactionThreadId}`
      : `discord:channel:${interaction.channelId}:user:${userInfo.userId}`;
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
          const resp = await this.forward({
            userId: `discord:${userInfo.userId}`,
            text,
            metadata: {
              guildId: userInfo.guildId,
              username: userInfo.username,
              command: commandName,
              channelId: interaction.channelId,
              sessionKey,
            },
          }, undefined, this.forwardTimeoutMs || undefined);
          if (!resp.ok) throw new Error(`Guardian returned status ${resp.status}`);
          const { answer = "No response received." } = await resp.json() as { answer?: string };

          const chunks = splitMessage(answer, MAX_MESSAGE_LENGTH);
          const firstChunk = chunks[0] ?? "No response received.";

          if (shouldQueue) {
            await interaction.followUp({ content: firstChunk, ephemeral: true });
            for (let i = 1; i < chunks.length; i++) {
              await interaction.followUp({ content: chunks[i], ephemeral: true });
            }
          } else {
            await interaction.editReply(firstChunk);
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
