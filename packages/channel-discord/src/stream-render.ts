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
  ComponentType,
  type ButtonInteraction,
  type Message,
  type ThreadChannel,
} from "discord.js";
import {
  OcClient,
  splitMessage,
  createLogger,
  asRaw,
  partSnapshotType,
  extractTextDelta,
  isTurnEnd,
  extractToolUpdate,
  extractPermissionAsk,
  extractQuestionAsk,
  isSessionError,
  type PermissionAsk,
  type QuestionAsk,
} from "@openpalm/channels-sdk";

/** Adapter-owned hook so a pending question can also be answered by the user
 * typing a normal message in the thread. `resolve(answer)` is the SINGLE
 * idempotent answer path shared by the buttons and the free-text reply — calling
 * it twice (e.g. a stale button click after a typed answer) is a safe no-op, so
 * the second answer never 404s. Set when asked, null when resolved/turn-ends. */
export type PendingQuestion = {
  requestID: string;
  requestingUserId: string;
  resolve: (answer: string) => Promise<void>;
};

const log = createLogger("channel-discord:stream");

/**
 * Channel-level guidance prepended ONCE to the first prompt of a Discord session.
 * Discord renders the `question` tool as interactive buttons (and free-text thread
 * replies), so we nudge the model to USE that tool when it wants the user to pick
 * between options instead of listing the choices as plain text. This lives in the
 * Discord package, so non-interactive channels (e.g. the API channel) never inject
 * it. Set DISCORD_SESSION_PREAMBLE="" to disable, or to your own text to override.
 */
export const DISCORD_SESSION_PREAMBLE =
  Bun.env.DISCORD_SESSION_PREAMBLE ??
  "[channel:discord] You are talking to the user over Discord. When you want the user to choose between options, or you are asking a question that has a few clear answers, ALWAYS call the `question` tool to present the choices — do not list the options as plain text. Discord renders that tool as clickable buttons (the user can also reply with their own answer).";

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
  /**
   * Optional one-time preamble prepended to THIS turn's prompt (e.g. the
   * Discord `question`-tool nudge on a session's first turn). Empty/undefined =
   * no preamble. The caller is responsible for sending it only when wanted (once
   * per session) so it doesn't repeat every turn.
   */
  sessionPreamble?: string;
  /**
   * Open the /event subscription for this turn. Defaults to a fresh
   * `client.events(userId)` stream, but the adapter passes a SHARED per-principal
   * subscription (OcEventHub) so concurrent threads don't each open a redundant
   * stream and trip the guardian's per-principal concurrent-stream cap. Returns
   * an async iterable with a `close()` the render loop calls on turn-end.
   */
  subscribeEvents?: () => AsyncIterable<unknown> & { close?: () => void };
  /** The user's triggering Discord message — tool use is shown as emoji reactions on it. */
  triggerMessage: Message;
  /**
   * Called when an interactive `question` is pending (so the adapter can also
   * accept a free-text answer typed in the thread) and with null when it
   * resolves / the turn ends.
   */
  setPendingQuestion?: (pending: PendingQuestion | null) => void;
}

/**
 * Run ONE streamed turn end-to-end. Creates the session (the GUARDIAN dedupes
 * per (channel, sessionKey), so multi-turn context is preserved and one thread
 * maps to one OpenCode session), subscribes to the filtered /event stream FIRST,
 * then prompt_asyncs with a generated messageID, and renders
 * deltas/tools/permissions/questions until turn-end. Resolves when the turn
 * reaches idle (so the conversation queue's run() promise settles per sessionKey)
 * or on timeout/abort.
 */
export async function streamTurn(args: StreamTurnArgs): Promise<void> {
  const { client, userId, requestingUserId, thread, sessionKey, text, sessionPreamble, subscribeEvents, triggerMessage, setPendingQuestion } = args;
  // Prepend the one-time channel preamble (question-tool nudge) to the user's
  // text. The caller passes it only on a session's first turn, so it never
  // repeats. The user's actual message stays last so it reads naturally.
  const promptText = sessionPreamble?.trim() ? `${sessionPreamble.trim()}\n\n${text}` : text;

  // Native Discord "typing…" indicator while the turn works — signals activity
  // during the pre-text phase (reasoning + tool steps) WITHOUT posting any
  // placeholder/Stop clutter. Cleared in finally (and auto-expires on Discord).
  const stopTyping = startTyping(thread);
  const ac = new AbortController();
  let active: ActiveMessage | null = null; // the currently-streaming assistant message
  // Shared per-principal /event subscription (OcEventHub) when provided, else a
  // dedicated stream. close()d in finally so the hub can refcount/idle-close.
  const subscription = subscribeEvents ? subscribeEvents() : null;

  try {
    // Guardian dedupes create per (channel, sessionKey) → one thread, one session.
    const sessionId = (await client.createSession(userId, sessionKey)).id;
    const eventsIter = subscription ?? client.events(userId, ac.signal); // subscribe BEFORE prompting (§4.2)
    // Fire the turn but DON'T await — /message resolves only at turn-end, and the
    // render loop drives off /event. If it errors, abort so the loop ends.
    void client.prompt(userId, sessionId, promptText).catch((err) => {
      log.warn("prompt_failed", { error: String(err), sessionId });
      ac.abort();
    });

    const reasoningParts = new Set<string>(); // partIDs typed "reasoning" → never shown
    const reactedEmojis = new Set<string>(); // tool emojis already reacted on the trigger message
    const deadline = Date.now() + TURN_RENDER_TIMEOUT_MS;
    for await (const ev of eventsIter) {
      if (Date.now() > deadline) {
        log.warn("turn_render_timeout", { sessionId });
        break;
      }
      const e = asRaw(ev);

      // Learn part types from snapshots so reasoning is filtered (a delta alone
      // can't be told apart — both stream field:"text").
      const snap = partSnapshotType(e);
      if (snap && snap.type === "reasoning") reasoningParts.add(snap.partID);

      if (isTurnEnd(e, sessionId)) break;
      if (isSessionError(e, sessionId)) {
        await thread.send("⚠️ The assistant connection reset. Please try again.").catch(() => {});
        break;
      }

      // Per-frame rendering is RESILIENT: one malformed frame must not abort the turn.
      try {
        const delta = extractTextDelta(e, sessionId, reasoningParts);
        if (delta) {
          // Each assistant message in the agent's sequence becomes its OWN Discord
          // message (sent when its first useful text arrives) — NOT one edited
          // placeholder, so the conversation reads naturally.
          const mid = typeof e.properties?.messageID === "string" ? e.properties.messageID : "";
          if (!active || (mid && active.messageId !== mid)) {
            await active?.finalize();
            active = new ActiveMessage(thread, mid);
          }
          await active.append(delta);
          continue;
        }

        const tool = extractToolUpdate(e, sessionId);
        if (tool && tool.callID) {
          // Tool use shows as a lightweight EMOJI REACTION on the user's message
          // (one per distinct tool kind) — no noisy embeds. The `question` tool
          // renders its own interactive prompt below.
          if (tool.tool !== "question") {
            const emoji = toolEmoji(tool.tool);
            if (!reactedEmojis.has(emoji)) {
              reactedEmojis.add(emoji);
              await triggerMessage.react(emoji).catch(() => {});
            }
          }
          continue;
        }

        const ask = extractPermissionAsk(e, sessionId);
        if (ask) {
          await renderPermissionPrompt(thread, client, userId, requestingUserId, ask);
          continue;
        }

        const question = extractQuestionAsk(e, sessionId);
        if (question) {
          await renderQuestionPrompt(thread, client, userId, requestingUserId, question, setPendingQuestion);
          continue;
        }
      } catch (err) {
        log.warn("frame_render_failed", { error: String(err), type: e.type, sessionId });
      }
    }
  } finally {
    stopTyping();
    setPendingQuestion?.(null); // clear any unanswered pending question for this thread
    subscription?.close?.(); // decref the shared /event stream (hub idle-closes)
    ac.abort();
    await active?.finalize().catch(() => {});
  }
}

/**
 * Show Discord's native "typing…" indicator for the thread until the returned
 * stop() is called. Re-fired every 8s (the indicator lasts ~10s). Best-effort.
 */
function startTyping(thread: ThreadChannel): () => void {
  const tick = () => void thread.sendTyping().catch(() => {});
  tick();
  const interval = setInterval(tick, 8000);
  return () => clearInterval(interval);
}

/** Tool kind → a compact reaction emoji (one per distinct kind per turn). */
function toolEmoji(tool: string): string {
  if (tool.startsWith("akm_")) {
    if (tool.includes("search") || tool.includes("curate")) return "🔎";
    if (tool.includes("memory") || tool.includes("remember")) return "🧠";
    return "📚";
  }
  switch (tool) {
    case "bash": return "🐚";
    case "read": case "glob": case "grep": case "list": return "📄";
    case "write": case "edit": case "patch": return "✏️";
    case "webfetch": case "websearch": return "🌐";
    case "task": return "🤖";
    default: return "🔧";
  }
}

// ── One streamed assistant message (sent, then throttle-edited) ─────────────
//
// Each assistant message in the agent's sequence is its OWN Discord message: the
// first useful text SENDS a message, later deltas EDIT it (throttled). A message
// with no text never sends (no empty "…" placeholders). Over 2000 chars splits
// into follow-up messages on finalize.
class ActiveMessage {
  readonly messageId: string;
  private readonly thread: ThreadChannel;
  private msg: Message | null = null;
  private buffer = "";
  private lastEdit = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(thread: ThreadChannel, messageId: string) {
    this.thread = thread;
    this.messageId = messageId;
  }

  async append(delta: string): Promise<void> {
    this.buffer += delta;
    const now = Date.now();
    if (now - this.lastEdit >= EDIT_THROTTLE_MS) {
      this.lastEdit = now;
      await this.flush();
    } else if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.lastEdit = Date.now();
        void this.flush();
      }, EDIT_THROTTLE_MS);
    }
  }

  private async flush(): Promise<void> {
    const head = splitMessage(this.buffer, MAX_MESSAGE_LENGTH)[0] ?? "";
    if (!head) return; // nothing renderable yet
    try {
      if (!this.msg) this.msg = await this.thread.send(head);
      else await this.msg.edit(head);
    } catch (err) {
      log.warn("edit_failed", { error: String(err) });
    }
  }

  async finalize(): Promise<void> {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (!this.buffer.trim()) return; // produced no text → no message
    const chunks = splitMessage(this.buffer, MAX_MESSAGE_LENGTH);
    try {
      if (!this.msg) this.msg = await this.thread.send(chunks[0] ?? "");
      else await this.msg.edit(chunks[0] ?? "");
    } catch {
      // ignore
    }
    for (let i = 1; i < chunks.length; i++) await this.thread.send(chunks[i]).catch(() => {});
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

// ── Interactive question (the `question` tool) ─────────────────────────────
//
// Renders the FIRST question's options as buttons (chunked into rows of 5), and
// registers a pending question so the user can ALSO answer by typing a normal
// message in the thread (the adapter routes that to replyQuestion). Answering by
// either path replies once and clears the pending state.
async function renderQuestionPrompt(
  thread: ThreadChannel,
  client: OcClient,
  userId: string,
  requestingUserId: string,
  ask: QuestionAsk,
  setPendingQuestion?: (pending: PendingQuestion | null) => void,
): Promise<void> {
  const q = ask.questions[0]; // v1: answer the first question (the common case)
  if (!q) return;

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const options = q.options.slice(0, 25); // Discord cap: 25 buttons (5 rows × 5)
  for (let i = 0; i < options.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const [j, opt] of options.slice(i, i + 5).entries()) {
      const idx = i + j;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`oc_q:${ask.requestID}:${idx}`)
          .setLabel((opt.label || `Option ${idx + 1}`).slice(0, 80))
          .setStyle(ButtonStyle.Primary),
      );
    }
    rows.push(row);
  }

  const header = q.header ? `**${q.header}**\n` : "";
  const optionLines = options.map((o) => `• **${o.label}**${o.description ? ` — ${o.description}` : ""}`).join("\n");
  const content = `${header}${q.question}${optionLines ? `\n${optionLines}` : ""}\n_Click an option below, or reply in this thread with your own answer._`;

  const prompt = await thread.send({ content: content.slice(0, 2000), components: rows });
  let collector: ReturnType<Message["createMessageComponentCollector"]> | undefined;

  // The SINGLE idempotent answer path. Both the buttons and the free-text reply
  // call this; the first answer wins, any later one is a safe no-op (no 404).
  let resolved = false;
  const resolveOnce = async (answer: string, interaction?: ButtonInteraction): Promise<void> => {
    if (resolved) {
      if (interaction) await interaction.reply({ content: "That question was already answered.", ephemeral: true }).catch(() => {});
      return;
    }
    resolved = true;
    setPendingQuestion?.(null);
    try { collector?.stop(); } catch { /* not started */ }
    let outcome: string;
    try {
      await client.replyQuestion(userId, ask.requestID, [[answer]]);
      outcome = `${header}${q.question}\n✅ ${answer}`.slice(0, 2000);
    } catch (err) {
      log.warn("question_reply_failed", { error: String(err), requestID: ask.requestID });
      outcome = `${header}${q.question}\n_(could not record that answer)_`.slice(0, 2000);
    }
    if (interaction) await interaction.update({ content: outcome, components: [] }).catch(() => {});
    else await prompt.edit({ content: outcome, components: [] }).catch(() => {});
  };

  // Free-text reply path (adapter routes a typed thread message here).
  setPendingQuestion?.({ requestID: ask.requestID, requestingUserId, resolve: (a) => resolveOnce(a) });

  if (rows.length === 0) return; // no options → free-text only (resolved via thread reply)

  collector = prompt.createMessageComponentCollector({ componentType: ComponentType.Button, time: BUTTON_COLLECTOR_MS });
  collector.on("collect", async (i: ButtonInteraction) => {
    if (i.user.id !== requestingUserId) {
      await i.reply({ content: "Only the requester can answer this question.", ephemeral: true }).catch(() => {});
      return;
    }
    const idx = Number(i.customId.split(":")[2]);
    await resolveOnce(options[idx]?.label ?? "", i);
  });
  collector.on("end", (collected) => {
    if (collected.size === 0 && !resolved) void prompt.edit({ components: [] }).catch(() => {}); // drop dead buttons
  });
}

// ── Exported pure helpers for unit tests ───────────────────────────────────

export const _internal = {
  extractTextDelta,
  isTurnEnd,
  extractToolUpdate,
  extractPermissionAsk,
  toolEmoji,
  asRaw,
};
