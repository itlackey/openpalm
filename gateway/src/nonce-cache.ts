/**
 * Time-bounded nonce cache to prevent replay attacks.
 * Stores seen nonces with their timestamps and rejects duplicates
 * or messages with stale timestamps beyond the allowed clock skew.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CLOCK_SKEW_MS = 300_000; // 5 minutes
const PRUNE_INTERVAL_MS = 60_000; // 1 minute

export class NonceCache {
  private seen = new Map<string, number>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly persistPath?: string) {
    this.loadFromDisk();
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
    this.persistToDisk();
    return true;
  }

  /** Remove entries older than the clock skew window. */
  private prune(): void {
    const cutoff = Date.now() - CLOCK_SKEW_MS;
    let changed = false;
    for (const [nonce, ts] of this.seen) {
      if (ts < cutoff) {
        this.seen.delete(nonce);
        changed = true;
      }
    }
    if (changed) this.persistToDisk();
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, "utf8");
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const entries = parsed.entries;
      if (!Array.isArray(entries)) return;
      for (const item of entries) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const nonce = item[0];
        const ts = item[1];
        if (typeof nonce !== "string" || typeof ts !== "number") continue;
        this.seen.set(nonce, ts);
      }
      this.prune();
    } catch {
      // If persistence file is corrupted, start fresh and overwrite on next write
      this.seen.clear();
    }
  }

  private persistToDisk(): void {
    if (!this.persistPath) return;
    try {
      const payload = JSON.stringify({ entries: Array.from(this.seen.entries()) });
      const parent = dirname(this.persistPath);
      mkdirSync(parent, { recursive: true });
      const temp = `${this.persistPath}.tmp`;
      writeFileSync(temp, payload, "utf8");
      renameSync(temp, this.persistPath);
    } catch {
      // best-effort persistence only
    }
  }

  /** Cleanup for tests or shutdown. */
  destroy(options?: { clear?: boolean }): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (options?.clear) {
      this.seen.clear();
      this.persistToDisk();
    }
  }
}

/** Singleton nonce cache instance for the gateway. */
export const nonceCache = new NonceCache(Bun.env.GATEWAY_NONCE_CACHE_PATH ?? "/app/data/nonce-cache.json");
