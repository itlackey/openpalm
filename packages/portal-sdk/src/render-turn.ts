/**
 * Shared rich-UX turn orchestration for OpenPalm chat portals.
 *
 * Both the Discord and Slack renderers consumed the guardian's filtered native
 * /event stream through the SAME skeleton — subscribe BEFORE prompting, fire the
 * prompt without awaiting, then a for-await loop that narrows each native frame
 * (`extractTextDelta` / `extractToolUpdate` / `extractPermissionAsk` /
 * `extractQuestionAsk` / `isTurnEnd` / `isSessionError`) under a render deadline —
 * plus an identical throttled-edit buffer. That shared machinery lives here so a
 * portal only supplies a platform `RenderSink` (Block Kit vs discord.js) and the
 * two behavioural knobs where the portals legitimately DIVERGE:
 *   - `onFrameError`: Discord wraps each frame's dispatch in try/catch ("one
 *     malformed frame must not abort the turn" → `'catch'`); Slack lets a throw
 *     end the turn (`'throw'`).
 *   - `checkTurnEndBefore`: Discord checks turn-end / session-error BEFORE the
 *     extract dispatch (`true`); Slack checks AFTER (`false`).
 *
 * The loop owns NO subscription / prompt / finalize lifecycle — that stays in each
 * portal's `streamTurn` (typing indicators, OcEventHub, placeholder posting, the
 * permission registry, the finally block) because those genuinely differ.
 */
import {
  asRaw,
  extractPermissionAsk,
  extractQuestionAsk,
  extractTextDelta,
  extractToolUpdate,
  isSessionError,
  isTurnEnd,
  partSnapshotType,
  type PermissionAsk,
  type QuestionAsk,
  type RawEvent,
  type ToolUpdate,
} from './oc-events.ts';

/**
 * A throttled buffer that accumulates streamed text and drives a platform edit.
 *
 * Algorithm (identical to the former Discord `ActiveMessage` / Slack
 * `TurnRenderer` internals): the first append past the throttle window flushes
 * IMMEDIATELY and returns the flush promise so the caller can await it; an append
 * inside the window schedules a SINGLE trailing flush so the final partial chunk
 * is never dropped. `cancelPending()` clears that trailing timer before a portal
 * does its own final flush on turn-end.
 *
 * The `onFlush` callback reads the accumulated text via `.text` and performs the
 * platform-specific edit (Discord message send/edit, Slack `chat.update`).
 */
export class ThrottledEditBuffer {
  private buffer = '';
  private lastEdit = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly throttleMs: number,
    private readonly onFlush: () => void | Promise<void>,
  ) {}

  /** The text accumulated so far — the `onFlush` callback renders this. */
  get text(): string {
    return this.buffer;
  }

  /**
   * Append a delta. Flushes now (returning the flush promise) if past the throttle
   * window, else schedules a single trailing flush.
   */
  append(delta: string): void | Promise<void> {
    this.buffer += delta;
    const now = Date.now();
    if (now - this.lastEdit >= this.throttleMs) {
      this.lastEdit = now;
      return this.onFlush();
    }
    if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.lastEdit = Date.now();
        void this.onFlush();
      }, this.throttleMs);
    }
  }

  /** Cancel a scheduled trailing flush (call before a portal's own final flush). */
  cancelPending(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }
}

/**
 * Platform-specific rendering surface the shared loop dispatches native frames
 * into. Discord rolls a new message per assistant `messageID` and reacts emojis;
 * Slack edits one Block Kit placeholder and posts tool status blocks — that all
 * lives behind these methods. Any method may return void or a promise; the loop
 * awaits it.
 */
export interface RenderSink {
  /** A text delta for the current assistant message. `messageID` is the native
   * frame's `properties.messageID` ("" when absent) so a portal can roll to a new
   * message when it changes. */
  onText(delta: string, messageID: string): void | Promise<void>;
  /** A tool-call update (already narrowed + guaranteed to carry a `callID`). */
  onTool(tool: ToolUpdate): void | Promise<void>;
  /** A permission request awaiting an approve/deny decision. */
  onPermission(ask: PermissionAsk): void | Promise<void>;
  /** An interactive `question` tool ask. */
  onQuestion(ask: QuestionAsk): void | Promise<void>;
  /** The guardian surfaced a session reset — render the notice; the loop then ends. */
  onSessionError(): void | Promise<void>;
}

export interface RenderTurnOptions {
  /** The session whose frames we render (correlation key — §4.2). */
  sessionId: string;
  /** Hard ceiling on one rendered turn so a stuck stream can't render forever. */
  turnRenderTimeoutMs: number;
  /**
   * `'catch'` (Discord) wraps each frame's dispatch in try/catch so one malformed
   * frame cannot abort the turn; `'throw'` (Slack) lets a throw propagate and end
   * the turn.
   */
  onFrameError: 'catch' | 'throw';
  /**
   * `true` (Discord) checks turn-end / session-error BEFORE the extract dispatch;
   * `false` (Slack) checks AFTER (a frame handled by the dispatch short-circuits
   * that after-check, matching the original `continue`).
   */
  checkTurnEndBefore: boolean;
  /** Called when a caught frame error is swallowed (`onFrameError: 'catch'`). */
  onFrameErrorLog?: (err: unknown, event: RawEvent) => void;
  /** Called once when the render deadline is hit and the loop breaks. */
  onTimeout?: () => void;
}

/**
 * Render one streamed turn: iterate the pre-opened /event stream, learn reasoning
 * part-ids from snapshots (so reasoning text is filtered), and dispatch each
 * native frame into the `sink` in the fixed order delta → tool → permission →
 * question, stopping at turn-end / session-error / deadline. Subscription, prompt,
 * and finalize lifecycle stay with the caller.
 */
export async function renderTurn(
  events: AsyncIterable<unknown>,
  sink: RenderSink,
  opts: RenderTurnOptions,
): Promise<void> {
  const { sessionId, turnRenderTimeoutMs, onFrameError, checkTurnEndBefore } = opts;
  const reasoningParts = new Set<string>(); // partIDs typed "reasoning" → never shown
  const deadline = Date.now() + turnRenderTimeoutMs;

  for await (const ev of events) {
    if (Date.now() > deadline) {
      opts.onTimeout?.();
      break;
    }
    const e = asRaw(ev);

    // Learn part types from snapshots so reasoning is filtered (a delta alone
    // can't be told apart — both stream field:"text").
    const snap = partSnapshotType(e);
    if (snap && snap.type === 'reasoning') reasoningParts.add(snap.partID);

    if (checkTurnEndBefore) {
      if (isTurnEnd(e, sessionId)) break;
      if (isSessionError(e, sessionId)) {
        await sink.onSessionError();
        break;
      }
    }

    let handled = false;
    const dispatch = async (): Promise<void> => {
      const delta = extractTextDelta(e, sessionId, reasoningParts);
      if (delta) {
        handled = true;
        const messageID = typeof e.properties?.messageID === 'string' ? e.properties.messageID : '';
        await sink.onText(delta, messageID);
        return;
      }
      const tool = extractToolUpdate(e, sessionId);
      if (tool?.callID) {
        handled = true;
        await sink.onTool(tool);
        return;
      }
      const ask = extractPermissionAsk(e, sessionId);
      if (ask) {
        handled = true;
        await sink.onPermission(ask);
        return;
      }
      const question = extractQuestionAsk(e, sessionId);
      if (question) {
        handled = true;
        await sink.onQuestion(question);
      }
    };

    if (onFrameError === 'catch') {
      try {
        await dispatch();
      } catch (err) {
        opts.onFrameErrorLog?.(err, e);
      }
    } else {
      await dispatch();
    }

    if (!checkTurnEndBefore && !handled) {
      if (isTurnEnd(e, sessionId)) break;
      if (isSessionError(e, sessionId)) {
        await sink.onSessionError();
        break;
      }
    }
  }
}
