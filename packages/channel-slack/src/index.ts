import { BaseChannel, createLogger, splitMessage, type HandleResult } from "@openpalm/channels-sdk";
import { App, type GenericMessageEvent, type KnownEventFromType } from "@slack/bolt";
import { checkPermissions, loadPermissionConfig } from "./permissions.ts";
import { ConversationQueue, resolveSessionKey } from "./session.ts";
import type { PermissionConfig, UserInfo } from "./types.ts";

const log = createLogger("channel-slack");

const MAX_MESSAGE_LENGTH = 4000;

export default class SlackChannel extends BaseChannel {
  name = "slack";

  private app: App | null = null;
  private permissions: PermissionConfig = loadPermissionConfig();
  private conversationQueue = new ConversationQueue();
  private botUserId: string | null = null;
  /** Cache of Slack user ID → display name to avoid repeated API calls. */
  private usernameCache = new Map<string, string>();

  /**
   * Threads the bot is actively participating in.
   * Map of "channel:thread_ts" → last activity timestamp (ms).
   * Threads expire after threadTtlMs of inactivity.
   */
  private activeThreads = new Map<string, number>();

  /** Thread inactivity TTL in ms. Default: 24 hours. */
  private threadTtlMs = (Number(Bun.env.SLACK_THREAD_TTL_HOURS) || 24) * 3_600_000;

  get botToken(): string {
    return Bun.env.SLACK_BOT_TOKEN ?? "";
  }

  get appToken(): string {
    return Bun.env.SLACK_APP_TOKEN ?? "";
  }

  /** BaseChannel requires this — not used for Socket Mode events. */
  async handleRequest(_req: Request): Promise<HandleResult | null> {
    return null;
  }

  override start(): void {
    super.start();
    void this.connectSocketMode();
  }

  // ── Socket Mode Connection ────────────────────────────────────────────

  private async connectSocketMode(): Promise<void> {
    if (!this.botToken) {
      log.error("startup_error", { reason: "SLACK_BOT_TOKEN not set" });
      process.exit(1);
    }
    if (!this.appToken) {
      log.error("startup_error", { reason: "SLACK_APP_TOKEN not set" });
      process.exit(1);
    }

    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
    });

    // Register event handlers
    this.app.event("message", async ({ event, say, client }) => {
      await this.onMessage(event as GenericMessageEvent, say, client);
    });

    this.app.event("app_mention", async ({ event, say, client }) => {
      await this.onAppMention(event, say, client);
    });

    this.app.command("/ask", async ({ command, ack, say, client }) => {
      await ack();
      await this.onAskCommand(command, say, client);
    });

    this.app.command("/clear", async ({ command, ack, say }) => {
      await ack();
      await this.onClearCommand(command, say);
    });

    this.app.command("/help", async ({ command, ack, say }) => {
      await ack();
      await this.onHelpCommand(command, say);
    });

    await this.app.start();

    // Resolve the bot's own user ID so we can strip self-mentions
    try {
      const authResult = await this.app.client.auth.test({ token: this.botToken });
      this.botUserId = (authResult.user_id as string) ?? null;
    } catch {
      log.warn("auth_test_failed", { reason: "Could not resolve bot user ID" });
    }

    log.info("socket_mode_connected", {
      botUserId: this.botUserId,
    });
  }

  // ── Thread Tracking ─────────────────────────────────────────────────

  private threadKey(channel: string, threadTs: string): string {
    return `${channel}:${threadTs}`;
  }

  private isThreadActive(channel: string, threadTs: string): boolean {
    const key = this.threadKey(channel, threadTs);
    const lastActivity = this.activeThreads.get(key);
    if (lastActivity === undefined) return false;
    if (Date.now() - lastActivity > this.threadTtlMs) {
      this.activeThreads.delete(key);
      return false;
    }
    return true;
  }

  private touchThread(channel: string, threadTs: string): void {
    this.activeThreads.set(this.threadKey(channel, threadTs), Date.now());
    if (this.activeThreads.size > 100) {
      const now = Date.now();
      for (const [id, ts] of this.activeThreads) {
        if (now - ts > this.threadTtlMs) this.activeThreads.delete(id);
      }
    }
  }

  // ── Message Handling ──────────────────────────────────────────────────

  private async onMessage(
    event: GenericMessageEvent,
    say: SayFn,
    client: SlackClient,
  ): Promise<void> {
    // Ignore bot messages, message_changed, etc.
    if (event.subtype) return;
    if (event.bot_id) return;
    if (this.botUserId && event.user === this.botUserId) return;
    if (!event.text?.trim()) return;

    const isDM = event.channel_type === "im";
    const inTrackedThread = event.thread_ts != null
      && this.isThreadActive(event.channel, event.thread_ts);

    // Respond to DMs and messages in threads the bot is already participating in
    if (!isDM && !inTrackedThread) return;

    const userInfo = await this.extractUserInfo(event, client);
    const permResult = checkPermissions(this.permissions, userInfo);
    if (!permResult.allowed) {
      await say({ text: "You do not have permission to use this bot.", thread_ts: event.ts });
      return;
    }

    const text = this.stripMention(event.text.trim());
    if (!text) return;

    const threadTs = event.thread_ts ?? event.ts;
    const sessionKey = resolveSessionKey({
      channelId: event.channel,
      userId: event.user,
      threadTs: event.thread_ts,
      isDM,
    });

    if (inTrackedThread) {
      this.touchThread(event.channel, event.thread_ts!);
    }

    await this.conversationQueue.runOrQueue(sessionKey, {
      onQueued: async () => {
        await say({ text: "Queued. I will pick this up next.", thread_ts: threadTs });
      },
      run: async () => {
        await this.runConversation(client, event.channel, threadTs, userInfo, text, sessionKey);
      },
    });
  }

  private async onAppMention(
    event: KnownEventFromType<"app_mention">,
    say: SayFn,
    client: SlackClient,
  ): Promise<void> {
    if (!event.text?.trim()) return;

    const username = await this.resolveUsername(event.user, client);
    const rawTeam = (event as Record<string, unknown>).team;
    const userInfo: UserInfo = {
      userId: event.user,
      teamId: typeof rawTeam === "string" ? rawTeam : "",
      channelId: event.channel,
      username,
    };

    const permResult = checkPermissions(this.permissions, userInfo);
    if (!permResult.allowed) {
      await say({ text: "You do not have permission to use this bot.", thread_ts: event.ts });
      return;
    }

    const text = this.stripMention(event.text);
    if (!text.trim()) {
      await say({ text: "Please provide a message.", thread_ts: event.ts });
      return;
    }

    // Always reply in thread — use existing thread or start new one
    const threadTs = event.thread_ts ?? event.ts;
    // Track this thread so the bot responds to follow-up messages without a mention
    this.touchThread(event.channel, threadTs);

    const sessionKey = resolveSessionKey({
      channelId: event.channel,
      userId: event.user,
      threadTs: threadTs,
      isDM: false,
    });

    await this.conversationQueue.runOrQueue(sessionKey, {
      onQueued: async () => {
        await say({ text: "Queued. I will pick this up next.", thread_ts: threadTs });
      },
      run: async () => {
        await this.runConversation(client, event.channel, threadTs, userInfo, text, sessionKey);
      },
    });
  }

  // ── Slash Commands ────────────────────────────────────────────────────

  private async onAskCommand(
    command: SlashCommand,
    say: SayFn,
    client: SlackClient,
  ): Promise<void> {
    const text = command.text?.trim();
    if (!text) {
      await say({ text: "Usage: `/ask <message>`" });
      return;
    }

    const userInfo: UserInfo = {
      userId: command.user_id,
      teamId: command.team_id,
      channelId: command.channel_id,
      username: command.user_name,
    };

    const permResult = checkPermissions(this.permissions, userInfo);
    if (!permResult.allowed) {
      await say({ text: "You do not have permission to use this bot." });
      return;
    }

    const sessionKey = resolveSessionKey({
      channelId: command.channel_id,
      userId: command.user_id,
      isDM: false,
    });

    await this.conversationQueue.runOrQueue(sessionKey, {
      onQueued: async () => {
        await say({ text: "Queued. I will pick this up next." });
      },
      run: async () => {
        // Post initial "thinking" message
        const thinkingResult = await client.chat.postMessage({
          channel: command.channel_id,
          text: `:hourglass: Processing your request...`,
        });
        const thinkingTs = thinkingResult.ts;

        try {
          const answer = await this.forwardToGuardian(userInfo.userId, text, {
            teamId: userInfo.teamId,
            username: userInfo.username,
            command: "ask",
            channelId: command.channel_id,
            sessionKey,
          });

          // Replace thinking message with answer
          const chunks = splitMessage(answer, MAX_MESSAGE_LENGTH);
          const firstChunk = chunks[0] ?? "No response received.";
          if (thinkingTs) {
            await client.chat.update({
              channel: command.channel_id,
              ts: thinkingTs,
              text: firstChunk,
            });
          }
          // Thread follow-up chunks under the initial message
          for (let i = 1; i < chunks.length; i++) {
            await client.chat.postMessage({
              channel: command.channel_id,
              text: chunks[i],
              thread_ts: thinkingTs,
            });
          }

          log.info("command_completed", {
            command: "ask",
            userId: userInfo.userId,
            channelId: command.channel_id,
            sessionKey,
          });
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          log.error("command_error", { command: "ask", error: errMsg, sessionKey });
          if (thinkingTs) {
            await client.chat.update({
              channel: command.channel_id,
              ts: thinkingTs,
              text: `Error: ${errMsg}`,
            });
          }
        }
      },
    });
  }

  private async onClearCommand(
    command: SlashCommand,
    say: SayFn,
  ): Promise<void> {
    const userInfo: UserInfo = {
      userId: command.user_id,
      teamId: command.team_id,
      channelId: command.channel_id,
      username: command.user_name,
    };

    const permResult = checkPermissions(this.permissions, userInfo);
    if (!permResult.allowed) {
      await say({ text: "You do not have permission to use this bot." });
      return;
    }

    const sessionKey = resolveSessionKey({
      channelId: command.channel_id,
      userId: command.user_id,
      isDM: false,
    });

    try {
      // Use this.forward directly — clear should not throw, we handle resp.ok manually
      const resp = await this.forward({
        userId: `slack:${userInfo.userId}`,
        text: "clear session",
        metadata: {
          command: "clear",
          channelId: command.channel_id,
          teamId: userInfo.teamId,
          username: userInfo.username,
          sessionKey,
          clearSession: true,
        },
      });

      if (!resp.ok) {
        await say({ text: "Could not clear this conversation right now." });
        return;
      }

      const droppedQueued = this.conversationQueue.clear(sessionKey);
      await say({
        text: droppedQueued > 0
          ? "Conversation cleared. Dropped queued follow-ups."
          : "Conversation cleared.",
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error("clear_error", { error: errMsg, sessionKey, userId: userInfo.userId });
      await say({ text: "Could not clear this conversation right now." });
    }
  }

  private async onHelpCommand(
    command: SlashCommand,
    say: SayFn,
  ): Promise<void> {
    const permResult = checkPermissions(this.permissions, {
      userId: command.user_id,
      teamId: command.team_id,
      channelId: command.channel_id,
      username: command.user_name,
    });
    if (!permResult.allowed) {
      await say({ text: "You do not have permission to use this bot." });
      return;
    }

    const lines = [
      "*Available Commands:*\n",
      "`/ask <message>` — Send a message to the assistant",
      "`/clear` — Start a fresh conversation (clears session context)",
      "`/help` — Show this help message",
      "\nYou can also mention me in any channel or send me a DM to start a conversation.",
    ];
    await say({ text: lines.join("\n") });
  }

  // ── Conversation Runner ───────────────────────────────────────────────

  private async runConversation(
    client: SlackClient,
    channel: string,
    threadTs: string,
    userInfo: UserInfo,
    text: string,
    sessionKey: string,
  ): Promise<void> {
    // Post a visible "thinking" message in the thread
    let thinkingTs: string | undefined;
    try {
      const result = await client.chat.postMessage({
        channel,
        text: `:hourglass: Processing your request...`,
        thread_ts: threadTs,
      });
      thinkingTs = result.ts;
    } catch {
      // Best-effort indicator; continue even if it fails
    }

    try {
      const answer = await this.forwardToGuardian(userInfo.userId, text, {
        teamId: userInfo.teamId,
        username: userInfo.username,
        channelId: channel,
        sessionKey,
      });

      // Replace thinking message with first chunk, post remaining as follow-ups
      const chunks = splitMessage(answer, MAX_MESSAGE_LENGTH);
      const firstChunk = chunks[0] ?? "No response received.";

      if (thinkingTs) {
        try {
          await client.chat.update({ channel, ts: thinkingTs, text: firstChunk });
        } catch {
          // If update fails, just post as new message
          await client.chat.postMessage({ channel, text: firstChunk, thread_ts: threadTs });
        }
      } else {
        await client.chat.postMessage({ channel, text: firstChunk, thread_ts: threadTs });
      }

      for (let i = 1; i < chunks.length; i++) {
        await client.chat.postMessage({ channel, text: chunks[i], thread_ts: threadTs });
      }

      log.info("message_completed", {
        userId: userInfo.userId,
        channelId: channel,
        threadTs,
        sessionKey,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error("message_error", { error: errMsg, userId: userInfo.userId, sessionKey });

      // Replace thinking message with error, or post error as new message
      if (thinkingTs) {
        try {
          await client.chat.update({ channel, ts: thinkingTs, text: `Error: ${errMsg}` });
          return;
        } catch {
          // fall through to post as new message
        }
      }
      await client.chat.postMessage({ channel, text: `Error: ${errMsg}`, thread_ts: threadTs });
    }
  }

  // ── Guardian Forwarding ───────────────────────────────────────────────

  /** Forward to guardian via HMAC-signed request. Throws on non-OK response. */
  private async forwardToGuardian(
    userId: string,
    text: string,
    metadata: Record<string, unknown>,
  ): Promise<string> {
    const resp = await this.forward({
      userId: `slack:${userId}`,
      text,
      metadata,
    });

    if (!resp.ok) {
      throw new Error(`Guardian returned status ${resp.status}`);
    }

    const result = (await resp.json()) as { answer?: string };
    return result.answer ?? "No response received.";
  }

  // ── Utilities ─────────────────────────────────────────────────────────

  private stripMention(text: string): string {
    if (!this.botUserId) return text;
    return text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();
  }

  /**
   * Resolve a Slack user ID to a display name, with caching.
   * Falls back to the user ID itself if the API call fails.
   */
  private async resolveUsername(userId: string, client: SlackClient): Promise<string> {
    const cached = this.usernameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await client.users.info({ user: userId });
      const name = result.user?.name ?? result.user?.real_name ?? userId;
      this.usernameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  private async extractUserInfo(event: GenericMessageEvent, client: SlackClient): Promise<UserInfo> {
    const rawTeam = (event as Record<string, unknown>).team;
    const username = await this.resolveUsername(event.user, client);
    return {
      userId: event.user,
      teamId: typeof rawTeam === "string" ? rawTeam : "",
      channelId: event.channel,
      username,
    };
  }
}

// Re-export splitMessage for tests (avoids breaking existing test imports)
export { splitMessage } from "@openpalm/channels-sdk";

// ── Type shorthands for Slack Bolt ────────────────────────────────────────
// Minimal subsets of the Bolt WebClient — only the methods this adapter uses.
// The full Bolt client (this.app.client) has additional methods like auth.test
// that are called directly on the Bolt instance, not through this type.

type SayFn = (msg: string | { text: string; thread_ts?: string }) => Promise<unknown>;

type SlackClient = {
  chat: {
    postMessage: (args: { channel: string; text: string; thread_ts?: string }) => Promise<{ ts?: string }>;
    update: (args: { channel: string; ts: string; text: string }) => Promise<unknown>;
  };
  users: {
    info: (args: { user: string }) => Promise<{ user?: { name?: string; real_name?: string } }>;
  };
};

type SlashCommand = {
  text: string;
  user_id: string;
  user_name: string;
  team_id: string;
  channel_id: string;
};
