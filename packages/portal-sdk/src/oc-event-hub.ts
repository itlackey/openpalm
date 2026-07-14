/**
 * Per-process shared OpenCode /event subscription.
 *
 * The guardian's /event stream is PRINCIPAL-scoped: a single subscription already
 * carries every event for every session the principal owns (ownership-filtered
 * fan-out). A second open would just duplicate that same stream.
 *
 * A user can run several turns at once (the ConversationQueue serializes turns
 * PER sessionKey, so different threads/DMs stream concurrently). If each turn
 * opened its OWN /event stream, they would each receive the full duplicate
 * frame set. This hub is shared by ALL stream-opening paths in both portals —
 * Discord/Slack streaming and the buffered `collectTurnAnswer` — so concurrent
 * same-principal turns share one upstream instead of opening redundant copies.
 *
 * This hub opens exactly ONE upstream /event stream per principal (userId) and
 * BROADCASTS every frame to all active per-turn subscribers, which each already
 * filter by their own sessionId (extractTextDelta/isTurnEnd/... are sessionID-
 * scoped). Refcounted: the upstream stays open while ≥1 turn is subscribed and
 * idle-closes a short grace after the last unsubscribes (absorbing between-turn
 * gaps without churning opens). If the upstream errors/closes, all subscribers
 * are ended so their turns finalize, and the next subscribe reopens.
 */
import type { OcClient } from './opencode.ts';

/** Grace period to keep the upstream open after the last turn unsubscribes, so
 * back-to-back turns in a thread don't churn open/close. Short — just bridges
 * the gap between turns.
 *
 * Configured via the portal-agnostic `PORTAL_EVENT_HUB_IDLE_MS` (this hub is
 * shared across portals). The legacy Discord-specific `DISCORD_EVENT_HUB_IDLE_MS`
 * is still honored as a backwards-compatible fallback. */
const IDLE_CLOSE_GRACE_MS =
  Number(Bun.env.PORTAL_EVENT_HUB_IDLE_MS ?? Bun.env.DISCORD_EVENT_HUB_IDLE_MS) || 30_000;

/** A single turn's view of the shared stream: a push-driven async iterator. */
class Subscriber implements AsyncIterable<unknown> {
  private queue: unknown[] = [];
  private waiting: ((r: IteratorResult<unknown>) => void) | null = null;
  private done = false;

  push(frame: unknown): void {
    if (this.done) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: frame, done: false });
    } else {
      this.queue.push(frame);
    }
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<unknown>>((resolve) => {
          this.waiting = resolve;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** The single upstream /event stream for one principal, fanned out to turns. */
class SharedStream {
  readonly subscribers = new Set<Subscriber>();
  private readonly ac = new AbortController();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly client: OcClient,
    private readonly userId: string,
    private readonly onClosed: () => void,
  ) {}

  start(): void {
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const ev of this.client.events(this.userId, this.ac.signal)) {
        for (const sub of this.subscribers) sub.push(ev);
      }
    } catch {
      // aborted (idle close) or upstream error — fall through to teardown
    } finally {
      for (const sub of this.subscribers) sub.end();
      this.subscribers.clear();
      this.onClosed();
    }
  }

  add(sub: Subscriber): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.subscribers.add(sub);
  }

  remove(sub: Subscriber): void {
    if (!this.subscribers.delete(sub)) return;
    sub.end();
    if (this.subscribers.size === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => this.ac.abort(), IDLE_CLOSE_GRACE_MS);
      this.idleTimer.unref?.();
    }
  }
}

/** A turn's subscription handle: iterate it for frames, close() when done. */
export interface EventSubscription extends AsyncIterable<unknown> {
  close(): void;
}

/** Opens at most one upstream /event stream per principal and fans it out. */
export class OcEventHub {
  private readonly streams = new Map<string, SharedStream>();

  constructor(private readonly client: OcClient) {}

  /**
   * Subscribe a turn to its principal's shared /event stream. Every frame is
   * delivered; the caller filters by sessionId (as the renderers already do).
   * MUST call close() when the turn ends (the render loop's finally does).
   */
  subscribe(userId: string): EventSubscription {
    let shared = this.streams.get(userId);
    if (!shared) {
      shared = new SharedStream(this.client, userId, () => {
        // Only forget this stream if it's still the current one (a fresh
        // subscribe during teardown may have already replaced it).
        if (this.streams.get(userId) === shared) this.streams.delete(userId);
      });
      this.streams.set(userId, shared);
      shared.start();
    }
    const sub = new Subscriber();
    shared.add(sub);
    const owner = shared;
    return {
      [Symbol.asyncIterator]: () => sub[Symbol.asyncIterator](),
      close: () => owner.remove(sub),
    };
  }

  /** Number of open upstream streams (for tests / introspection). */
  get openStreamCount(): number {
    return this.streams.size;
  }
}
