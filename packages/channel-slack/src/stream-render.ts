/**
 * Slack rich-UX streaming renderer (design §4.3, §4.2) — Stage 5.
 *
 * Mirrors the Discord renderer (Stage 4) but renders with Block Kit and Slack's
 * `chat.update`-style streaming instead of Discord message edits:
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
 *   - throttled `chat.update` edits (~1 edit / EDIT_THROTTLE_MS), rolling to a
 *     new threaded message past Slack's 4000-char limit via splitMessage (§4.3);
 *   - tool-call status posted as a Block Kit context block, updated in place;
 *   - on `permission.asked`, Block Kit Approve / Always / Deny buttons restricted
 *     to the requesting Slack user → POST /permission/{requestID}/reply (signed,
 *     ownership-checked by the guardian); "Always" maps to reply:"always";
 *   - a Stop button → POST /session/{id}/abort.
 *
 * ALL native-OpenCode-event interpretation (delta / tool / permission / turn-end)
 * is the SAME shared pure logic Discord uses, imported from
 * `@openpalm/channels-sdk` (oc-events) — no per-channel duplication (§2.2). Only
 * the Block Kit rendering and the Slack interaction wiring live here.
 *
 * Slack button clicks arrive centrally via `app.action(...)`, not per-message
 * collectors, so this file exposes a `SlackPermissionRegistry` the adapter wires
 * to its single action handler; the renderer records the principal + requesting
 * user for each pending `requestID`/stop so the handler can authorize + relay.
 */

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

const log = createLogger("channel-slack:stream");

// ── Named tunables (design §4.3, §3.6 edit-throttle) ───────────────────────

/** Slack hard message length. */
const MAX_MESSAGE_LENGTH = 4000;
/** Edit throttle — ~1 update / 1.25s to stay under Slack chat.update rate limits (§4.3, ~750–1500ms). */
const EDIT_THROTTLE_MS = Number(Bun.env.SLACK_EDIT_THROTTLE_MS) || 1250;
/** Hard ceiling on a single rendered turn so a stuck stream can't render forever. */
const TURN_RENDER_TIMEOUT_MS = Number(Bun.env.SLACK_TURN_RENDER_TIMEOUT_MS) || 10 * 60_000;

// ── Block Kit action_ids (shared with the adapter's central action handler) ──

export const ACTION_PERM_ONCE = "oc_perm_once";
export const ACTION_PERM_ALWAYS = "oc_perm_always";
export const ACTION_PERM_DENY = "oc_perm_deny";
export const ACTION_STOP = "oc_stop";

// ── Minimal Slack WebClient subset this renderer uses ──────────────────────

export type StreamSlackClient = {
  chat: {
    postMessage: (args: {
      channel: string;
      text: string;
      thread_ts?: string;
      blocks?: unknown[];
    }) => Promise<{ ts?: string }>;
    update: (args: {
      channel: string;
      ts: string;
      text: string;
      blocks?: unknown[];
    }) => Promise<unknown>;
  };
};

// ── Permission / stop interaction registry (wired to app.action) ───────────

/** A pending permission prompt awaiting a Block Kit button click. */
export interface PendingPermission {
  /** Principal userId that signs the /oc reply (e.g. "slack:U123"). */
  userId: string;
  /** The Slack user.id allowed to click (§4.3 interaction identity). */
  requestingUserId: string;
  permission: string;
  channel: string;
  /** ts of the message carrying the buttons (so the handler can update it). */
  ts: string;
  /** When the entry was registered — set by the registry for TTL pruning. */
  createdAt?: number;
}

/** A pending stop control for an in-flight turn. */
export interface PendingStop {
  userId: string;
  requestingUserId: string;
  sessionId: string;
}

/**
 * Adapter-owned registry the single `app.action` handler consults. The renderer
 * records entries; the handler authorizes (interaction identity), relays the
 * signed /oc call, and clears the entry. Guardian-state stays in the guardian;
 * this is purely local Slack interaction bookkeeping.
 */
/**
 * How long an unclicked permission entry lingers before it is pruned. A prompt
 * the user never clicks (ignored, or the turn ended) would otherwise leak its
 * registry entry forever. The guardian also forgets the requestID on TTL, so a
 * reply after this window would 403 anyway — keep the two roughly aligned.
 */
const PERMISSION_ENTRY_TTL_MS = Number(Bun.env.SLACK_PERMISSION_ENTRY_TTL_MS ?? 15 * 60_000);
/** Hard cap so a flood of unclicked prompts cannot grow the map without bound. */
const PERMISSION_ENTRIES_MAX = 10_000;

export class SlackPermissionRegistry {
  private readonly client: OcClient;
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly stops = new Map<string, PendingStop>();

  constructor(client: OcClient) {
    this.client = client;
  }

  registerPermission(requestID: string, p: PendingPermission): void {
    this.pruneExpiredPermissions();
    this.permissions.set(requestID, { ...p, createdAt: p.createdAt ?? Date.now() });
    if (this.permissions.size > PERMISSION_ENTRIES_MAX) this.pruneExpiredPermissions(true);
  }

  /** Drop permission entries past their TTL (lazy — called on register). When
   * `force`, also evict oldest-first if still over the hard cap. */
  private pruneExpiredPermissions(force = false): void {
    const cutoff = Date.now() - PERMISSION_ENTRY_TTL_MS;
    for (const [id, p] of this.permissions) {
      if ((p.createdAt ?? 0) < cutoff) this.permissions.delete(id);
    }
    if (force && this.permissions.size > PERMISSION_ENTRIES_MAX) {
      const sorted = [...this.permissions.entries()].sort((a, b) => (a[1].createdAt ?? 0) - (b[1].createdAt ?? 0));
      for (const [id] of sorted.slice(0, sorted.length - PERMISSION_ENTRIES_MAX)) this.permissions.delete(id);
    }
  }

  /** Active pending-permission count (for parity with guardian /stats discipline + tests). */
  pendingPermissionCount(): number {
    return this.permissions.size;
  }

  registerStop(sessionId: string, s: PendingStop): void {
    this.stops.set(sessionId, s);
  }

  clearStop(sessionId: string): void {
    this.stops.delete(sessionId);
  }

  /**
   * Handle a permission button click. Returns the human-readable outcome to
   * render back into the message, or null if the click is unauthorized/unknown
   * (the caller renders nothing/an ephemeral warning). PURE w.r.t. Slack — it
   * only touches the OcClient + the local map.
   */
  async handlePermissionClick(
    requestID: string,
    action: string,
    clickerUserId: string,
  ): Promise<{ text: string; channel: string; ts: string } | null> {
    const pending = this.permissions.get(requestID);
    if (!pending) return null;
    // Interaction identity: only the requesting Slack user may decide (§4.3).
    if (clickerUserId !== pending.requestingUserId) return null;

    const reply = action === ACTION_PERM_ONCE ? "once" : action === ACTION_PERM_ALWAYS ? "always" : "reject";
    try {
      await this.client.replyPermission(pending.userId, requestID, reply);
      this.permissions.delete(requestID);
      return {
        text: `Permission *${pending.permission}* → ${reply}.`,
        channel: pending.channel,
        ts: pending.ts,
      };
    } catch (err) {
      log.warn("permission_reply_failed", { error: String(err), requestID });
      this.permissions.delete(requestID);
      return {
        text: "Could not record that decision (it may have expired).",
        channel: pending.channel,
        ts: pending.ts,
      };
    }
  }

  /** Handle a Stop button click. Returns true if it authorized + issued the abort. */
  async handleStopClick(sessionId: string, clickerUserId: string): Promise<boolean> {
    const pending = this.stops.get(sessionId);
    if (!pending) return false;
    if (clickerUserId !== pending.requestingUserId) return false;
    try {
      await this.client.abort(pending.userId, sessionId);
    } catch (err) {
      log.warn("abort_failed", { error: String(err), sessionId });
    }
    return true;
  }
}

// ── Block Kit builders (pure) ───────────────────────────────────────────────

/** Buttons carry their target id in `value` so the central handler can route them. */
export function buildPermissionBlocks(ask: PermissionAsk): unknown[] {
  const patterns = ask.patterns.length ? `\n\`${ask.patterns.join("`, `")}\`` : "";
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `Permission requested: *${ask.permission}*${patterns}` },
    },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: ACTION_PERM_ONCE, value: ask.requestID, style: "primary", text: { type: "plain_text", text: "Approve" } },
        { type: "button", action_id: ACTION_PERM_ALWAYS, value: ask.requestID, text: { type: "plain_text", text: "Always" } },
        { type: "button", action_id: ACTION_PERM_DENY, value: ask.requestID, style: "danger", text: { type: "plain_text", text: "Deny" } },
      ],
    },
  ];
}

/** Streaming-answer blocks: the live text plus a Stop button (value = sessionId). */
export function buildAnswerBlocks(text: string, sessionId: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: text || "…" } },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: ACTION_STOP, value: sessionId, text: { type: "plain_text", text: "Stop" } },
      ],
    },
  ];
}

/** A tool-call status as a context block (no interactivity). */
export function buildToolBlocks(tool: ToolUpdate): unknown[] {
  const detail = tool.title ?? `status: ${tool.status}`;
  const err = tool.error ? ` — ${tool.error}` : "";
  return [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `:wrench: *${tool.tool}* — ${detail} (${tool.status}${err})` }],
    },
  ];
}

// ── Public entry: render one streamed turn into a Slack thread ──────────────

export interface SlackStreamTurnArgs {
  client: OcClient;
  registry: SlackPermissionRegistry;
  slack: StreamSlackClient;
  /** The principal userId (e.g. "slack:U123") — signs every /oc call. */
  userId: string;
  /** The Slack user.id allowed to click permission/stop buttons (§4.3). */
  requestingUserId: string;
  /** The Slack channel id to post into. */
  channel: string;
  /** The thread_ts to render under (the user's message / thread root). */
  threadTs: string;
  /** The session key for guardian grouping (e.g. "slack:thread:C:1.2"). */
  sessionKey: string;
  /** The user's prompt text. */
  text: string;
}

/**
 * Run ONE streamed turn end-to-end. Opens (or reuses) a session, subscribes to
 * the filtered /event stream FIRST, then prompt_asyncs with a generated
 * messageID, and renders deltas/tools/permissions until turn-end. Resolves when
 * the turn reaches idle (so the conversation queue's run() promise settles per
 * sessionKey), or on timeout/abort.
 */
export async function streamTurn(args: SlackStreamTurnArgs): Promise<void> {
  const { client, registry, slack, userId, requestingUserId, channel, threadTs, sessionKey, text } = args;

  const session = await client.createSession(userId, sessionKey);
  const sessionId = session.id;
  const messageId = generateMessageId();

  // Subscribe BEFORE prompting (§4.2) so no frame is missed.
  const ac = new AbortController();
  const eventsIter = client.events(userId, ac.signal);

  // Post the live placeholder (carries the Stop button).
  const placeholder = await slack.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "…",
    blocks: buildAnswerBlocks("…", sessionId),
  });
  const answerTs = placeholder.ts;
  if (answerTs) {
    registry.registerStop(sessionId, { userId, requestingUserId, sessionId });
  }

  // Kick off the prompt now that we're subscribed.
  await client.promptAsync(userId, sessionId, messageId, text);

  const renderer = new TurnRenderer(slack, channel, threadTs, answerTs, sessionId);
  const toolTs = new Map<string, string>(); // callID → message ts

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
        await renderToolMessage(slack, channel, threadTs, toolTs, tool);
        continue;
      }

      const ask = extractPermissionAsk(e, sessionId);
      if (ask) {
        await renderPermissionPrompt(slack, registry, channel, threadTs, userId, requestingUserId, ask);
        continue;
      }

      if (isTurnEnd(e, sessionId)) break;

      // Upstream reset (guardian synthetic session.error) → surface + stop.
      if (isSessionError(e, sessionId)) {
        await slack.chat.postMessage({ channel, thread_ts: threadTs, text: "The assistant connection reset. Please try again." });
        break;
      }
    }
  } finally {
    ac.abort();
    registry.clearStop(sessionId);
    await renderer.finalize().catch(() => {});
  }
}

// ── Incremental text renderer (throttled chat.update + 4000-char roll) ──────

class TurnRenderer {
  private buffer = "";
  private lastEdit = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly slack: StreamSlackClient,
    private readonly channel: string,
    private readonly threadTs: string,
    private readonly answerTs: string | undefined,
    private readonly sessionId: string,
  ) {}

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

  /** Update the placeholder with the head chunk; never exceed the Slack limit. */
  private async flush(): Promise<void> {
    if (!this.answerTs) return;
    const chunks = splitMessage(this.buffer, MAX_MESSAGE_LENGTH);
    const head = chunks[0] ?? "…";
    try {
      await this.slack.chat.update({
        channel: this.channel,
        ts: this.answerTs,
        text: head || "…",
        blocks: buildAnswerBlocks(head || "…", this.sessionId),
      });
    } catch (err) {
      log.warn("update_failed", { error: String(err) });
    }
  }

  /** On turn-end: write the final head chunk (drop the Stop button) + thread the rest. */
  async finalize(): Promise<void> {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    const chunks = splitMessage(this.buffer || "No response received.", MAX_MESSAGE_LENGTH);
    const head = chunks[0] ?? "No response received.";
    if (this.answerTs) {
      try {
        // Final update drops the Stop button (no blocks → plain text).
        await this.slack.chat.update({ channel: this.channel, ts: this.answerTs, text: head });
      } catch {
        // ignore
      }
    } else {
      await this.slack.chat.postMessage({ channel: this.channel, thread_ts: this.threadTs, text: head }).catch(() => {});
    }
    for (let i = 1; i < chunks.length; i++) {
      await this.slack.chat.postMessage({ channel: this.channel, thread_ts: this.threadTs, text: chunks[i] }).catch(() => {});
    }
  }
}

// ── Tool status messages (updated in place by callID) ──────────────────────

async function renderToolMessage(
  slack: StreamSlackClient,
  channel: string,
  threadTs: string,
  toolTs: Map<string, string>,
  tool: ToolUpdate,
): Promise<void> {
  const blocks = buildToolBlocks(tool);
  const fallback = `${tool.tool}: ${tool.status}`;
  const existing = toolTs.get(tool.callID);
  try {
    if (existing) {
      await slack.chat.update({ channel, ts: existing, text: fallback, blocks });
    } else {
      const msg = await slack.chat.postMessage({ channel, thread_ts: threadTs, text: fallback, blocks });
      if (msg.ts) toolTs.set(tool.callID, msg.ts);
    }
  } catch (err) {
    log.warn("tool_message_failed", { error: String(err) });
  }
}

// ── Permission prompt (Block Kit buttons → central app.action handler) ──────

async function renderPermissionPrompt(
  slack: StreamSlackClient,
  registry: SlackPermissionRegistry,
  channel: string,
  threadTs: string,
  userId: string,
  requestingUserId: string,
  ask: PermissionAsk,
): Promise<void> {
  const blocks = buildPermissionBlocks(ask);
  try {
    const msg = await slack.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `Permission requested: ${ask.permission}`,
      blocks,
    });
    if (msg.ts) {
      registry.registerPermission(ask.requestID, {
        userId,
        requestingUserId,
        permission: ask.permission,
        channel,
        ts: msg.ts,
      });
    }
  } catch (err) {
    log.warn("permission_prompt_failed", { error: String(err), requestID: ask.requestID });
  }
}

// ── Exported pure helpers for unit tests ───────────────────────────────────

export const _internal = {
  buildPermissionBlocks,
  buildAnswerBlocks,
  buildToolBlocks,
};
