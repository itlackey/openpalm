/**
 * Replay detection via timestamp + nonce checking.
 *
 * Rejects messages with timestamps outside a 5-minute clock skew window
 * and tracks seen nonces to prevent replay attacks. Periodically prunes
 * expired entries and enforces a hard cap of 50,000 nonces.
 */

const CLOCK_SKEW = 300_000;
const seen = new Map<string, number>();

function pruneNonceCache(): void {
  const cutoff = Date.now() - CLOCK_SKEW;
  for (const [k, v] of seen) {
    if (v < cutoff) seen.delete(k);
  }

  // Hard cap: if still over 50,000 after pruning expired, delete oldest entries first
  if (seen.size > 50_000) {
    const sorted = [...seen.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = sorted.slice(0, sorted.length - 50_000);
    for (const [k] of toRemove) seen.delete(k);
  }
}

// Periodic pruning every 60 seconds regardless of map size
setInterval(pruneNonceCache, 60_000);

export function checkNonce(nonce: string, ts: number): boolean {
  if (Math.abs(Date.now() - ts) > CLOCK_SKEW) return false;
  if (seen.has(nonce)) return false;
  seen.set(nonce, ts);

  // Time-based pruning: clean expired entries when map grows large
  if (seen.size > 10_000) {
    pruneNonceCache();
  }
  return true;
}

/** Expose nonce cache size for the /stats endpoint. */
export function nonceCacheSize(): number {
  return seen.size;
}

/** Expose constants for the /stats endpoint. */
export const NONCE_WINDOW_MS = CLOCK_SKEW;
export const NONCE_MAX_SIZE = 50_000;
