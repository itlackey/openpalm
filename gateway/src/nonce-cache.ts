/**
 * Time-bounded nonce cache to prevent replay attacks.
 * Stores seen nonces with their timestamps and rejects duplicates
 * or messages with stale timestamps beyond the allowed clock skew.
 */

const CLOCK_SKEW_MS = 300_000; // 5 minutes
const PRUNE_INTERVAL_MS = 60_000; // 1 minute

export class NonceCache {
  private seen = new Map<string, number>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    // Allow the process to exit even if the timer is active
    if (this.pruneTimer && typeof this.pruneTimer === "object" && "unref" in this.pruneTimer) {
      this.pruneTimer.unref();
    }
  }

  /**
   * Checks whether a nonce+timestamp pair is valid (not replayed, not stale).
   * Returns true if the request should be allowed, false if it should be rejected.
   */
  checkAndStore(nonce: string, timestamp: number): boolean {
    // Reject stale timestamps beyond allowed clock skew
    if (Math.abs(Date.now() - timestamp) > CLOCK_SKEW_MS) {
      return false;
    }

    // Reject duplicate nonces
    if (this.seen.has(nonce)) {
      return false;
    }

    this.seen.set(nonce, timestamp);
    return true;
  }

  /** Remove entries older than the clock skew window. */
  private prune(): void {
    const cutoff = Date.now() - CLOCK_SKEW_MS;
    for (const [nonce, ts] of this.seen) {
      if (ts < cutoff) {
        this.seen.delete(nonce);
      }
    }
  }

  /** Cleanup for tests or shutdown. */
  destroy(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.seen.clear();
  }
}

/** Singleton nonce cache instance for the gateway. */
export const nonceCache = new NonceCache();
