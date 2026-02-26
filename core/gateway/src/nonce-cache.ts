const CLOCK_SKEW_MS = 300_000; // 5 minutes
const PRUNE_INTERVAL_MS = 60_000; // 1 minute

export class NonceCache {
  private seen = new Map<string, number>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    if (this.pruneTimer && typeof this.pruneTimer === "object" && "unref" in this.pruneTimer) {
      this.pruneTimer.unref();
    }
  }

  checkAndStore(nonce: string, timestamp: number): boolean {
    if (Math.abs(Date.now() - timestamp) > CLOCK_SKEW_MS) return false;
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, timestamp);
    return true;
  }

  private prune(): void {
    const cutoff = Date.now() - CLOCK_SKEW_MS;
    for (const [nonce, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(nonce);
    }
  }

  destroy(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }
}
