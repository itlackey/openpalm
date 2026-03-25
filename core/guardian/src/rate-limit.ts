/**
 * Fixed-window rate limiting.
 *
 * Tracks per-key request counts in fixed time windows. Supports both
 * per-user and per-channel limits. Periodically prunes expired entries
 * and enforces a hard cap of 10,000 buckets.
 *
 * NOTE: This is a fixed-window rate limiter. A client can send `limit` requests
 * at the end of one window and `limit` at the start of the next, achieving 2x burst
 * in a short span. This is acceptable for the guardian's use case (LAN-first,
 * secondary to HMAC auth), but could be upgraded to a sliding window if needed.
 */

export const USER_RATE_LIMIT = 120;
export const USER_RATE_WINDOW_MS = 60_000;
export const CHANNEL_RATE_LIMIT = 200;
export const CHANNEL_RATE_WINDOW_MS = 60_000;

const buckets = new Map<string, { count: number; start: number }>();

/** Maximum number of rate-limit buckets before hard-cap eviction. */
const MAX_BUCKETS = 10_000;

/** Prune expired buckets. Uses the larger window (channel) as the expiry threshold. */
function pruneRateLimitBuckets(): void {
  const now = Date.now();
  const maxWindow = Math.max(USER_RATE_WINDOW_MS, CHANNEL_RATE_WINDOW_MS);
  for (const [k, b] of buckets) {
    if (now - b.start > maxWindow) buckets.delete(k);
  }

  // Hard cap: if still over limit after pruning expired, delete oldest entries first
  if (buckets.size > MAX_BUCKETS) {
    const sorted = [...buckets.entries()].sort((a, b) => a[1].start - b[1].start);
    const toRemove = sorted.slice(0, sorted.length - MAX_BUCKETS);
    for (const [k] of toRemove) buckets.delete(k);
  }
}

// Periodic pruning every 60 seconds regardless of map size
// unref() so the timer doesn't keep the event loop alive (cleaner testing + shutdown).
const pruneTimer = setInterval(pruneRateLimitBuckets, 60_000);
pruneTimer.unref();

export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();

  // Evict stale buckets when map is too large
  if (buckets.size > MAX_BUCKETS) {
    pruneRateLimitBuckets();
  }

  const b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    buckets.set(key, { count: 1, start: now });
    return true;
  }
  if (b.count >= limit) return false;
  b.count++;
  return true;
}

/** Returns counts of active user and channel rate limiters for /stats. */
export function activeRateLimiters(): { activeUserLimiters: number; activeChannelLimiters: number } {
  const now = Date.now();
  let activeUserLimiters = 0;
  let activeChannelLimiters = 0;
  for (const [key, b] of buckets) {
    const windowMs = key.startsWith("ch:") ? CHANNEL_RATE_WINDOW_MS : USER_RATE_WINDOW_MS;
    if (now - b.start > windowMs) continue; // expired
    if (key.startsWith("ch:")) {
      activeChannelLimiters++;
    } else {
      activeUserLimiters++;
    }
  }
  return { activeUserLimiters, activeChannelLimiters };
}
