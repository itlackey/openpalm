/**
 * Discord rich-UX streaming renderer (design §4.1, §4.2) — Stage 4.
 *
 * Consumes the guardian's filtered native /event stream (OcClient.events) and
 * renders a single Discord turn live:
 *   - persistent, pre-opened filtered /event subscription (opened BEFORE the
 *     first prompt_async so no frame can arrive before a subscriber exists —
 *     §4.2);
 *   - the channel generates a msg_… messageID for prompt_async (the assistant
 *     reply carries its OWN server id, so frames are correlated by sessionID,
 *     not messageID — live-verified §4.2);
 *   - renders until turn-end = `session.status` reaching an idle state, with
 *     `session.idle` as a fallback (§1.1);
 *   - prefers the fine-grained `session.next.*` delta family where present,
 *     falling back to `message.part.delta`/`message.part.updated` (§1.1);
 *   - throttled placeholder edits (~1 edit / EDIT_THROTTLE_MS), rolling to a new
 *     message past Discord's 2000-char limit via splitMessage (§4.1);
 *   - tool-call embeds colored by `state.status`;
 *   - on `permission.asked`, an ActionRow (Approve / Always / Deny) restricted to
 *     the requesting user.id → POST /permission/{requestID}/reply (signed,
 *     ownership-checked by the guardian); "Always" maps to reply:"always";
 *   - a Stop button → POST /session/{id}/abort.
 *
 * The OpenCode wire types come from `@opencode-ai/sdk`; we narrow defensively by
 * `event.type` and tolerate unknown event shapes (graceful degrade, §5). This
 * file holds NO guardian state — it is pure Discord rendering over OcClient.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType,
  type ButtonInteraction,
  type Message,
  type ThreadChannel,
} from "discord.js";
import {
  OcClient,
  generateMessageId,
  splitMessage,
  createLogger,
  asRaw,
  extractTextDelta,
  isTurnEnd,
  extractToolUpdate,
  extractPermissionAsk,
  isSessionError,
  type ToolUpdate,
  type PermissionAsk,
} from "@openpalm/channels-sdk";

const log = createLogger("channel-discord:stream");

// ── Named tunables (design §4.1, §3.6 edit-throttle) ───────────────────────

/** Discord hard message length. */
const MAX_MESSAGE_LENGTH = 2000;
/** Edit throttle — ~1 edit / 1.25s to stay under Discord edit rate limits (§4.1, ~750–1500ms). */
const EDIT_THROTTLE_MS = Number(Bun.env.DISCORD_EDIT_THROTTLE_MS) || 1250;
/** Hard ceiling on a single rendered turn so a stuck stream can't render forever. */
const TURN_RENDER_TIMEOUT_MS = Number(Bun.env.DISCORD_TURN_RENDER_TIMEOUT_MS) || 10 * 60_000;
/** Discord interaction collector lifetime for permission/stop buttons. */
const BUTTON_COLLECTOR_MS = Number(Bun.env.DISCORD_BUTTON_COLLECTOR_MS) || 5 * 60_000;

// ── Discord-specific render helpers ─────────────────────────────────────────
// Pure event interpreters (extractTextDelta/isTurnEnd/extractToolUpdate/
// extractPermissionAsk/asRaw) are shared via @openpalm/channels-sdk — every
// rich-UX renderer reads the same native OpenCode frames identically (§4.2).

function toolColor(status: string): number {
  switch (status) {
    case "completed":
      return 0x57f287; // green
    case "error":
      return 0xed4245; // red
    case "pending":
      return 0xfee75c; // yellow
    default:
      return 0x5865f2; // blurple (running)
  }
}

// ── Public entry: render one streamed turn into a Discord thread ───────────

export interface StreamTurnArgs {
  client: OcClient;
  /** The principal userId (e.g. "discord:123") — signs every /oc call. */
  userId: string;
  /** The Discord user.id allowed to click permission/stop buttons (§4.1). */
  requestingUserId: string;
  /** The thread to render into. */
  thread: ThreadChannel;
  /** The session key for guardian grouping (e.g. "discord:thread:42"). */
  sessionKey: string;
  /** The user's prompt text. */
  text: string;
}

/**
 * Run ONE streamed turn end-to-end. Opens (or reuses) a session, subscribes to
 * the filtered /event stream FIRST, then prompt_asyncs with a generated
 * messageID, and renders deltas/tools/permissions until turn-end. Resolves when
 * the turn reaches idle (so the conversation queue's run() promise settles per
 * sessionKey — design note on conversationQueue), or on timeout/abort.
 */
export async function streamTurn(args: StreamTurnArgs): Promise<void> {
  const { client, userId, requestingUserId, thread, sessionKey, text } = args;

  const session = await client.createSession(userId, sessionKey);
  const sessionId = session.id;
  const messageId = generateMessageId();

  // Subscribe BEFORE prompting (§4.2) so no frame is missed.
  const ac = new AbortController();
  const eventsIter = client.events(userId, ac.signal);

  const placeholder = await thread.send("…");
  const stopRow = buildStopRow();
  await placeholder.edit({ content: "…", components: [stopRow] });

  // Wire the Stop button → abort.
  const stopCollector = placeholder.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: BUTTON_COLLECTOR_MS,
  });
  stopCollector.on("collect", (i: ButtonInteraction) => {
    if (i.customId !== "oc_stop") return;
    if (i.user.id !== requestingUserId) {
      void i.reply({ content: "Only the requester can stop this turn.", ephemeral: true });
      return;
    }
    void client.abort(userId, sessionId).catch((err) => log.warn("abort_failed", { error: String(err) }));
    void i.reply({ content: "Stopping…", ephemeral: true });
  });

  // Kick off the prompt now that we're subscribed.
  await client.promptAsync(userId, sessionId, messageId, text);

  const renderer = new TurnRenderer(placeholder, stopRow);
  const toolEmbeds = new Map<string, Message>(); // callID → embed message

  const deadline = Date.now() + TURN_RENDER_TIMEOUT_MS;
  try {
    for await (const ev of eventsIter) {
      if (Date.now() > deadline) {
        log.warn("turn_render_timeout", { sessionId });
        break;
      }
      const e = asRaw(ev);

      const delta = extractTextDelta(e, sessionId);
      if (delta) {
        await renderer.appendText(delta);
        continue;
      }

      const tool = extractToolUpdate(e, sessionId);
      if (tool && tool.callID) {
        await renderToolEmbed(thread, toolEmbeds, tool);
        continue;
      }

      const ask = extractPermissionAsk(e, sessionId);
      if (ask) {
        await renderPermissionPrompt(thread, client, userId, requestingUserId, ask);
        continue;
      }

      if (isTurnEnd(e, sessionId)) break;

      // Upstream reset (guardian synthetic session.error) → surface + stop.
      if (isSessionError(e, sessionId)) {
        await thread.send("The assistant connection reset. Please try again.");
        break;
      }
    }
  } finally {
    ac.abort();
    stopCollector.stop();
    await renderer.finalize(thread).catch(() => {});
  }
}

// ── Incremental text renderer (throttled edits + 2000-char roll) ───────────

class TurnRenderer {
  private buffer = "";
  private lastEdit = 0;
  private current: Message;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly stopRow: ActionRowBuilder<ButtonBuilder>;

  constructor(first: Message, stopRow: ActionRowBuilder<ButtonBuilder>) {
    this.current = first;
    this.stopRow = stopRow;
  }

  async appendText(delta: string): Promise<void> {
    this.buffer += delta;
    const now = Date.now();
    if (now - this.lastEdit >= EDIT_THROTTLE_MS) {
      this.lastEdit = now;
      await this.flush();
    } else if (!this.pendingTimer) {
      // Schedule a trailing flush so the final partial chunk isn't dropped.
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.lastEdit = Date.now();
        void this.flush();
      }, EDIT_THROTTLE_MS);
    }
  }

  /** Edit the current message with the head chunk; never exceed the Discord limit. */
  private async flush(): Promise<void> {
    const chunks = splitMessage(this.buffer, MAX_MESSAGE_LENGTH);
    const head = chunks[0] ?? "…";
    try {
      await this.current.edit({ content: head || "…", components: [this.stopRow] });
    } catch (err) {
      log.warn("edit_failed", { error: String(err) });
    }
  }

  /** On turn-end: write any remaining chunks as follow-up messages, drop the Stop button. */
  async finalize(thread: ThreadChannel): Promise<void> {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    const chunks = splitMessage(this.buffer || "No response received.", MAX_MESSAGE_LENGTH);
    try {
      await this.current.edit({ content: chunks[0] ?? "No response received.", components: [] });
    } catch {
      // ignore
    }
    for (let i = 1; i < chunks.length; i++) {
      await thread.send(chunks[i]);
    }
  }
}

// ── Tool embeds ────────────────────────────────────────────────────────────

async function renderToolEmbed(
  thread: ThreadChannel,
  embeds: Map<string, Message>,
  tool: ToolUpdate,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(toolColor(tool.status))
    .setTitle(`🔧 ${tool.tool}`)
    .setDescription(tool.title ?? `status: ${tool.status}`)
    .setFooter({ text: tool.status + (tool.error ? ` — ${tool.error}` : "") });

  const existing = embeds.get(tool.callID);
  try {
    if (existing) {
      await existing.edit({ embeds: [embed] });
    } else {
      const msg = await thread.send({ embeds: [embed] });
      embeds.set(tool.callID, msg);
    }
  } catch (err) {
    log.warn("tool_embed_failed", { error: String(err) });
  }
}

// ── Permission ActionRow (Approve / Always / Deny) ─────────────────────────

async function renderPermissionPrompt(
  thread: ThreadChannel,
  client: OcClient,
  userId: string,
  requestingUserId: string,
  ask: PermissionAsk,
): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`oc_perm_once:${ask.requestID}`).setLabel("Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`oc_perm_always:${ask.requestID}`).setLabel("Always").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`oc_perm_deny:${ask.requestID}`).setLabel("Deny").setStyle(ButtonStyle.Danger),
  );
  const patterns = ask.patterns.length ? `\n\`${ask.patterns.join("`, `")}\`` : "";
  const prompt = await thread.send({
    content: `Permission requested: **${ask.permission}**${patterns}`,
    components: [row],
  });

  const collector = prompt.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: BUTTON_COLLECTOR_MS,
    max: 1,
  });

  collector.on("collect", async (i: ButtonInteraction) => {
    // Interaction identity: only the requesting Discord user may decide (§4.1).
    if (i.user.id !== requestingUserId) {
      await i.reply({ content: "Only the requester can answer this permission prompt.", ephemeral: true });
      return;
    }
    const [action] = i.customId.split(":");
    const reply = action === "oc_perm_once" ? "once" : action === "oc_perm_always" ? "always" : "reject";
    try {
      await client.replyPermission(userId, ask.requestID, reply);
      await i.update({
        content: `Permission **${ask.permission}** → ${reply}.`,
        components: [],
      });
    } catch (err) {
      log.warn("permission_reply_failed", { error: String(err), requestID: ask.requestID });
      await i.update({ content: "Could not record that decision (it may have expired).", components: [] });
    }
  });

  collector.on("end", (collected) => {
    if (collected.size === 0) {
      void prompt.edit({ content: `Permission **${ask.permission}** timed out.`, components: [] }).catch(() => {});
    }
  });
}

// ── Stop button row ─────────────────────────────────────────────────────────

function buildStopRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("oc_stop").setLabel("Stop").setStyle(ButtonStyle.Secondary),
  );
}

// ── Exported pure helpers for unit tests ───────────────────────────────────

export const _internal = {
  extractTextDelta,
  isTurnEnd,
  extractToolUpdate,
  extractPermissionAsk,
  toolColor,
  asRaw,
};
