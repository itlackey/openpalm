import {
  asRaw,
  ConversationQueue,
  extractTextDelta,
  isTurnEnd,
  OcClient,
  partSnapshotType,
  SecretFileError,
  createLogger,
  readRequiredSecretFile,
  splitMessage,
} from './runtime.ts';
import { App, type GenericMessageEvent, type KnownEventFromType } from "@slack/bolt";
import { checkPermissions, loadPermissionConfig } from "./permissions.ts";
import {
  SlackPermissionRegistry,
  streamTurn,
  ACTION_PERM_ONCE,
  ACTION_PERM_ALWAYS,
  ACTION_PERM_DENY,
  ACTION_STOP,
  type StreamSlackClient,
} from "./stream-render.ts";
import type { PermissionConfig, UserInfo } from "./types.ts";

const log = createLogger("channel-slack");

const MAX_MESSAGE_LENGTH = 4000;
const DEFAULT_FORWARD_TIMEOUT_MS = 1_800_000;
const ASK_MODAL_CALLBACK_ID = "ask_openpalm_modal";
const ASK_MODAL_INPUT_BLOCK_ID = "ask_openpalm_prompt_block";
const ASK_MODAL_INPUT_ACTION_ID = "ask_openpalm_prompt_action";
const ASK_GLOBAL_SHORTCUT_ID = "ask_openpalm";
const ASK_MESSAGE_SHORTCUT_ID = "ask_openpalm_message";

function parseForwardTimeoutMs(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_FORWARD_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

type ForwardResult = {
  userId: string;
  text: string;
  metadata?: Record<string, unknown>;
};

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default class SlackChannel {
  name = "slack";
  port: number = Number(Bun.env.PORT) || 8080;
  guardianUrl = 'http://guardian:8080';
  private _fetchFn: typeof fetch = fetch;

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

  /** Forward timeout in ms. Default: 30 minutes. */
  private forwardTimeoutMs = parseForwardTimeoutMs(Bun.env.SLACK_FORWARD_TIMEOUT_MS);

  /**
   * Opt-in rich-UX streaming (design Stage 5). When false (default), the
   * buffered /channel/inbound path is used — byte-for-byte the legacy behavior
   * (§7). When true, thread turns render live via the guardian /oc/* proxy with
   * Block Kit tool status + interactive permission prompts.
   */
  private streamingEnabled = Bun.env.SLACK_STREAMING === "true";

  /** Lazily-built native OpenCode client through the guardian /oc/* proxy. */
  private ocClientInstance: OcClient | null = null;
  /** Lazily-built permission/stop interaction registry (wired to app.action). */
  private permissionRegistryInstance: SlackPermissionRegistry | null = null;

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

  private get permissionRegistry(): SlackPermissionRegistry {
    if (!this.permissionRegistryInstance) {
      this.permissionRegistryInstance = new SlackPermissionRegistry(this.ocClient);
    }
    return this.permissionRegistryInstance;
  }

  get botToken(): string {
    return readRequiredSecretFile("SLACK_BOT_TOKEN_FILE");
  }

  get appToken(): string {
    return readRequiredSecretFile("SLACK_APP_TOKEN_FILE");
  }

  get secret(): string {
    return readRequiredSecretFile('PRINCIPAL_SECRET_FILE');
  }

  async handleRequest(_req: Request): Promise<null> {
    return null;
  }

  private async forward(result: ForwardResult, fetchFn?: typeof fetch, timeoutMs?: number): Promise<Response> {
    const fn = fetchFn ?? this._fetchFn;
    const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const client = new OcClient({
        principalId: Bun.env.PRINCIPAL_ID ?? this.name,
        secret: this.secret,
        baseUrl: `${this.guardianUrl}/oc`,
        fetch: fn,
      });
      const sessionKey = typeof result.metadata?.sessionKey === 'string' ? result.metadata.sessionKey : result.userId;
      const session = await client.createSession(result.userId, sessionKey);
      const answerPromise = collectTurnAnswer(client, result.userId, session.id, controller?.signal ?? new AbortController().signal);
      await client.prompt(result.userId, session.id, result.text);
      const answer = await answerPromise;
      return json(200, { userId: result.userId, sessionId: session.id, answer });
    } finally {
      if (timer) clearTimeout(timer);
      controller?.abort();
    }
  }

  createFetch(fetchFn: typeof fetch = fetch): (req: Request) => Promise<Response> {
    this._fetchFn = fetchFn;
    return async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return json(200, { ok: true, service: `channel-${this.name}` });
      }
      return json(404, { error: 'not_found' });
    };
  }

  start(): void {
    try {
      this.secret;
    } catch (err) {
      log.error('startup_error', {
        reason: err instanceof SecretFileError ? err.message : 'PRINCIPAL_SECRET_FILE could not be read',
      });
      process.exit(1);
    }

    try {
      Bun.serve({ port: this.port, fetch: this.createFetch() });
      log.info('started', { port: this.port });
    } catch (err) {
      log.error('failed to start server', {
        port: this.port,
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }

    void this.connectSocketMode();
  }

  // ── Socket Mode Connection ────────────────────────────────────────────

  private async connectSocketMode(): Promise<void> {
    let botToken: string;
    let appToken: string;
    try {
      botToken = this.botToken;
      appToken = this.appToken;
    } catch (err) {
      log.error("startup_error", { reason: err instanceof Error ? err.message : "Slack secret file could not be read" });
      process.exit(1);
    }

    this.app = new App({
      token: botToken,
      appToken,
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

    this.app.shortcut(ASK_GLOBAL_SHORTCUT_ID, async ({ shortcut, ack, client }) => {
      await ack();
      await this.onGlobalShortcut(shortcut as GlobalShortcut, client as SlackClient);
    });

    this.app.shortcut(ASK_MESSAGE_SHORTCUT_ID, async ({ shortcut, ack, client }) => {
      await ack();
      await this.onMessageShortcut(shortcut as MessageShortcut, client as SlackClient);
    });

    this.app.view(ASK_MODAL_CALLBACK_ID, async ({ body, view, ack, client }) => {
      await ack();
      await this.onAskModalSubmission(
        body as ViewSubmissionBody,
        view as ModalView,
        client as SlackClient,
      );
    });

    this.app.event("app_home_opened", async ({ event, client }) => {
      await this.onAppHomeOpened(event as AppHomeOpenedEvent, client as SlackClient);
    });

    // Rich-UX (Stage 5) Block Kit interactions: permission decisions + Stop.
    // ONE central handler per action_id routes the click to the registry, which
    // authorizes (interaction identity) and relays the signed /oc reply (§4.3).
    if (this.streamingEnabled) {
      for (const actionId of [ACTION_PERM_ONCE, ACTION_PERM_ALWAYS, ACTION_PERM_DENY]) {
        this.app.action(actionId, async ({ body, ack, client }) => {
          await ack();
          await this.onPermissionAction(actionId, body as BlockActionBody, client as SlackClient);
        });
      }
      this.app.action(ACTION_STOP, async ({ body, ack, client }) => {
        await ack();
        await this.onStopAction(body as BlockActionBody, client as SlackClient);
      });
    }

    this.app.error(async (error) => {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error("bolt_app_error", { error: errMsg });
    });

    await this.app.start();

    // Resolve the bot's own user ID so we can strip self-mentions
    try {
      const authResult = await this.app.client.auth.test({ token: botToken });
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

    // Skip @mentions in tracked threads — onAppMention handles these.
    // Processing both causes duplicate responses.
    if (inTrackedThread && this.botUserId && event.text.includes(`<@${this.botUserId}>`)) return;

    const userInfo = await this.extractUserInfo(event, client);
    const permResult = checkPermissions(this.permissions, userInfo);
    if (!permResult.allowed) {
      await say({ text: "You do not have permission to use this bot.", thread_ts: event.ts });
      return;
    }

    const text = this.stripMention(event.text.trim());
    if (!text) return;

    const threadTs = event.thread_ts ?? event.ts;
    const sessionKey = event.thread_ts
      ? `slack:thread:${event.channel}:${event.thread_ts}`
      : isDM
        ? `slack:dm:${event.user}`
        : `slack:channel:${event.channel}:user:${event.user}`;

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

    const sessionKey = threadTs
      ? `slack:thread:${event.channel}:${threadTs}`
      : `slack:channel:${event.channel}:user:${event.user}`;

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

  private buildAskModalView(initialPrompt: string, metadata: ModalMetadata): SlackViewDefinition {
    return {
      type: "modal",
      callback_id: ASK_MODAL_CALLBACK_ID,
      private_metadata: JSON.stringify(metadata),
      title: {
        type: "plain_text",
        text: "Ask OpenPalm",
      },
      submit: {
        type: "plain_text",
        text: "Ask",
      },
      close: {
        type: "plain_text",
        text: "Cancel",
      },
      blocks: [
        {
          type: "input",
          block_id: ASK_MODAL_INPUT_BLOCK_ID,
          label: {
            type: "plain_text",
            text: "Prompt",
          },
          element: {
            type: "plain_text_input",
            action_id: ASK_MODAL_INPUT_ACTION_ID,
            multiline: true,
            initial_value: initialPrompt,
          },
        },
      ],
    };
  }

  private async onGlobalShortcut(shortcut: GlobalShortcut, client: SlackClient): Promise<void> {
    const metadata: ModalMetadata = {
      source: "global-shortcut",
      teamId: shortcut.team?.id,
    };

    try {
      await client.views.open({
        trigger_id: shortcut.trigger_id,
        view: this.buildAskModalView("", metadata),
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error("shortcut_modal_open_error", {
        source: "global-shortcut",
        userId: shortcut.user.id,
        error: errMsg,
      });
    }
  }

  private async onMessageShortcut(shortcut: MessageShortcut, client: SlackClient): Promise<void> {
    const messageText = shortcut.message.text?.trim() ?? "";
    const initialPrompt = messageText
      ? `Ask OpenPalm about this message:\n${messageText}\n\n`
      : "Ask OpenPalm about this message:\n\n";

    const metadata: ModalMetadata = {
      source: "message-shortcut",
      channelId: shortcut.channel.id,
      threadTs: shortcut.message.ts,
      teamId: shortcut.team?.id,
    };

    try {
      await client.views.open({
        trigger_id: shortcut.trigger_id,
        view: this.buildAskModalView(initialPrompt, metadata),
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error("shortcut_modal_open_error", {
        source: "message-shortcut",
        userId: shortcut.user.id,
        channelId: shortcut.channel.id,
        error: errMsg,
      });
    }
  }

  private parseModalMetadata(raw: string | undefined): ModalMetadata {
    if (!raw) return { source: "global-shortcut" };
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const source = parsed.source === "message-shortcut" ? "message-shortcut" : "global-shortcut";
      return {
        source,
        channelId: typeof parsed.channelId === "string" ? parsed.channelId : undefined,
        threadTs: typeof parsed.threadTs === "string" ? parsed.threadTs : undefined,
        teamId: typeof parsed.teamId === "string" ? parsed.teamId : undefined,
      };
    } catch {
      return { source: "global-shortcut" };
    }
  }

  private getModalPrompt(view: ModalView): string {
    const blockValues = view.state.values[ASK_MODAL_INPUT_BLOCK_ID];
    if (!blockValues) return "";
    const actionValues = blockValues[ASK_MODAL_INPUT_ACTION_ID];
    return typeof actionValues?.value === "string" ? actionValues.value.trim() : "";
  }

  private async onAskModalSubmission(
    body: ViewSubmissionBody,
    view: ModalView,
    client: SlackClient,
  ): Promise<void> {
    const text = this.getModalPrompt(view);
    if (!text) {
      log.warn("modal_submission_empty_prompt", { userId: body.user.id });
      return;
    }

    const metadata = this.parseModalMetadata(view.private_metadata);

    try {
      let channelId = metadata.channelId;
      if (!channelId) {
        const openResult = await client.conversations.open({ users: body.user.id });
        channelId = openResult.channel?.id;
        if (!channelId) {
          throw new Error("Could not resolve DM channel for modal response");
        }
      }

      const userInfo: UserInfo = {
        userId: body.user.id,
        teamId: body.team?.id ?? metadata.teamId ?? "",
        channelId,
        username: body.user.username ?? body.user.name,
      };

      const permResult = checkPermissions(this.permissions, userInfo);
      if (!permResult.allowed) {
        await client.chat.postMessage({
          channel: channelId,
          text: "You do not have permission to use this bot.",
          thread_ts: metadata.threadTs,
        });
        return;
      }

      const sessionKey = metadata.threadTs
        ? `slack:thread:${channelId}:${metadata.threadTs}`
        : channelId.startsWith("D")
          ? `slack:dm:${userInfo.userId}`
          : `slack:channel:${channelId}:user:${userInfo.userId}`;

      await this.conversationQueue.runOrQueue(sessionKey, {
        onQueued: async () => {
          await client.chat.postMessage({
            channel: channelId,
            text: "Queued. I will pick this up next.",
            thread_ts: metadata.threadTs,
          });
        },
        run: async () => {
          if (metadata.threadTs) {
            await this.runConversation(client, channelId, metadata.threadTs, userInfo, text, sessionKey);
            return;
          }

          const thinkingResult = await client.chat.postMessage({
            channel: channelId,
            text: `:hourglass: Processing your request...`,
          });
          const thinkingTs = thinkingResult.ts;

          try {
            const resp = await this.forward({
              userId: `slack:${userInfo.userId}`,
              text,
              metadata: {
                teamId: userInfo.teamId,
                username: userInfo.username,
                command: "ask_modal",
                channelId,
                sessionKey,
              },
            }, undefined, this.forwardTimeoutMs);
            if (!resp.ok) throw new Error(`Guardian returned status ${resp.status}`);
            const { answer = "No response received." } = await resp.json() as { answer?: string };

            const chunks = splitMessage(answer, MAX_MESSAGE_LENGTH);
            const firstChunk = chunks[0] ?? "No response received.";

            if (thinkingTs) {
              await client.chat.update({
                channel: channelId,
                ts: thinkingTs,
                text: firstChunk,
              });
            }
            for (let i = 1; i < chunks.length; i++) {
              await client.chat.postMessage({
                channel: channelId,
                text: chunks[i],
                thread_ts: thinkingTs,
              });
            }

            log.info("modal_submission_completed", {
              source: metadata.source,
              userId: userInfo.userId,
              channelId,
              sessionKey,
            });
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            log.error("modal_submission_error", {
              source: metadata.source,
              userId: userInfo.userId,
              channelId,
              sessionKey,
              error: errMsg,
            });
            if (thinkingTs) {
              await client.chat.update({
                channel: channelId,
                ts: thinkingTs,
                text: `Error: ${errMsg}`,
              });
            }
          }
        },
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error("modal_submission_error", {
        source: metadata.source,
        userId: body.user.id,
        error: errMsg,
      });
    }
  }

  private async onAppHomeOpened(event: AppHomeOpenedEvent, client: SlackClient): Promise<void> {
    try {
      await client.views.publish({
        user_id: event.user,
        view: {
          type: "home",
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: "OpenPalm on Slack",
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "Ask questions from DMs, mentions, slash commands, or shortcuts.",
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "*Quick commands*\n• `/ask <message>` ask a question\n• `/clear` reset your session\n• `/help` show usage info",
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "*Shortcuts*\n• `Ask OpenPalm` (global shortcut)\n• `Ask OpenPalm about this message` (message shortcut)",
              },
            },
          ],
        },
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error("app_home_publish_error", {
        userId: event.user,
        error: errMsg,
      });
    }
  }

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

    const sessionKey = `slack:channel:${command.channel_id}:user:${command.user_id}`;

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
          const resp = await this.forward({
            userId: `slack:${userInfo.userId}`,
            text,
            metadata: {
              teamId: userInfo.teamId,
              username: userInfo.username,
              command: "ask",
              channelId: command.channel_id,
              sessionKey,
            },
          }, undefined, this.forwardTimeoutMs);
          if (!resp.ok) throw new Error(`Guardian returned status ${resp.status}`);
          const { answer = "No response received." } = await resp.json() as { answer?: string };

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

    const sessionKey = `slack:channel:${command.channel_id}:user:${command.user_id}`;

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
      }, undefined, this.forwardTimeoutMs);

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
    // Rich-UX streaming path (opt-in, Stage 5). Renders deltas + Block Kit tool
    // status + interactive permission prompts live via the guardian /oc/* proxy.
    // The conversationQueue's run() promise settles when streamTurn resolves at
    // turn-end (session idle), keeping per-sessionKey serialization intact.
    if (this.streamingEnabled) {
      try {
        await streamTurn({
          client: this.ocClient,
          registry: this.permissionRegistry,
          slack: client as unknown as StreamSlackClient,
          userId: `slack:${userInfo.userId}`,
          requestingUserId: userInfo.userId,
          channel,
          threadTs,
          sessionKey,
          text,
        });
        log.info("stream_completed", { userId: userInfo.userId, channelId: channel, threadTs, sessionKey });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log.error("stream_error", { error: errMsg, userId: userInfo.userId, sessionKey });
        await client.chat.postMessage({ channel, text: `Error: ${errMsg}`, thread_ts: threadTs }).catch(() => {});
      }
      return;
    }

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
      const resp = await this.forward({
        userId: `slack:${userInfo.userId}`,
        text,
        metadata: {
          teamId: userInfo.teamId,
          username: userInfo.username,
          channelId: channel,
          sessionKey,
        },
      }, undefined, this.forwardTimeoutMs);
      if (!resp.ok) throw new Error(`Guardian returned status ${resp.status}`);
      const { answer = "No response received." } = await resp.json() as { answer?: string };

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

  // ── Rich-UX interactions (Block Kit buttons → guardian /oc reply) ─────────

  private actionFirstValue(body: BlockActionBody): string | undefined {
    const action = body.actions?.[0];
    return typeof action?.value === "string" ? action.value : undefined;
  }

  private async onPermissionAction(
    actionId: string,
    body: BlockActionBody,
    client: SlackClient,
  ): Promise<void> {
    const requestID = this.actionFirstValue(body);
    if (!requestID) return;
    const clicker = body.user?.id ?? "";
    const outcome = await this.permissionRegistry.handlePermissionClick(requestID, actionId, clicker);
    if (!outcome) {
      // Unknown/expired request OR a non-requester clicked — refuse quietly.
      log.warn("permission_action_unauthorized_or_unknown", { requestID, actionId, clicker });
      return;
    }
    try {
      await client.chat.update({ channel: outcome.channel, ts: outcome.ts, text: outcome.text });
    } catch (error) {
      log.warn("permission_action_update_failed", { error: error instanceof Error ? error.message : String(error), requestID });
    }
  }

  private async onStopAction(body: BlockActionBody, _client: SlackClient): Promise<void> {
    const sessionId = this.actionFirstValue(body);
    if (!sessionId) return;
    const clicker = body.user?.id ?? "";
    const handled = await this.permissionRegistry.handleStopClick(sessionId, clicker);
    if (!handled) {
      log.warn("stop_action_unauthorized_or_unknown", { sessionId, clicker });
    }
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

async function collectTurnAnswer(client: OcClient, userId: string, sessionId: string, signal: AbortSignal): Promise<string> {
  const reasoningPartIds = new Set<string>();
  let answer = '';
  for await (const event of client.events(userId, signal)) {
    const raw = asRaw(event);
    const snapshot = partSnapshotType(raw);
    if (snapshot?.type === 'reasoning') reasoningPartIds.add(snapshot.partID);
    const delta = extractTextDelta(raw, sessionId, reasoningPartIds);
    if (delta) answer += delta;
    if (isTurnEnd(raw, sessionId)) break;
  }
  return answer || '(no response)';
}

export { DEFAULT_FORWARD_TIMEOUT_MS, parseForwardTimeoutMs };

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
  conversations: {
    open: (args: { users: string }) => Promise<{ channel?: { id?: string } }>;
  };
  users: {
    info: (args: { user: string }) => Promise<{ user?: { name?: string; real_name?: string } }>;
  };
  views: {
    open: (args: { trigger_id: string; view: SlackViewDefinition }) => Promise<unknown>;
    publish: (args: { user_id: string; view: HomeViewDefinition }) => Promise<unknown>;
  };
};

type SlashCommand = {
  text: string;
  user_id: string;
  user_name: string;
  team_id: string;
  channel_id: string;
};

type GlobalShortcut = {
  trigger_id: string;
  user: { id: string; username?: string; name?: string };
  team?: { id?: string };
};

type MessageShortcut = GlobalShortcut & {
  channel: { id: string };
  message: { ts: string; text?: string };
};

type ModalMetadata = {
  source: "global-shortcut" | "message-shortcut";
  channelId?: string;
  threadTs?: string;
  teamId?: string;
};

type ModalView = {
  private_metadata?: string;
  state: {
    values: Record<string, Record<string, { value?: string }>>;
  };
};

type ViewSubmissionBody = {
  user: { id: string; username?: string; name?: string };
  team?: { id?: string };
};

type BlockActionBody = {
  user?: { id?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
};

type SlackViewDefinition = {
  type: "modal";
  callback_id: string;
  private_metadata: string;
  title: { type: "plain_text"; text: string };
  submit: { type: "plain_text"; text: string };
  close: { type: "plain_text"; text: string };
  blocks: Array<{
    type: "input";
    block_id: string;
    label: { type: "plain_text"; text: string };
    element: {
      type: "plain_text_input";
      action_id: string;
      multiline: boolean;
      initial_value: string;
    };
  }>;
};

type HomeViewDefinition = {
  type: "home";
  blocks: Array<{
    type: "header" | "section";
    text: {
      type: "plain_text" | "mrkdwn";
      text: string;
    };
  }>;
};

type AppHomeOpenedEvent = {
  user: string;
};
