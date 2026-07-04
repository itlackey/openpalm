/**
 * Fixed-window rate limiting.
 *
 * Tracks per-key request counts in fixed time windows. Supports both
 * per-user and per-portal limits. Periodically prunes expired entries
 * and enforces a hard cap of 10,000 buckets.
 *
 * NOTE: This is a fixed-window rate limiter. A client can send `limit` requests
 * at the end of one window and `limit` at the start of the next, achieving 2x burst
 * in a short span. This is acceptable for the guardian's use case (LAN-first,
 * secondary to HMAC auth), but could be upgraded to a sliding window if needed.
 */

import { FixedWindowLimiter } from "./bounded-map";

export const USER_RATE_LIMIT = 120;
export const USER_RATE_WINDOW_MS = 60_000;
export const PORTAL_RATE_LIMIT = 200;
export const PORTAL_RATE_WINDOW_MS = 60_000;

/** Maximum number of rate-limit buckets before hard-cap eviction. */
const MAX_BUCKETS = 10_000;

// One shared limiter for both per-user and per-portal buckets. The prune expiry
// threshold is the larger of the two windows; each allow() call still passes its
// own per-call window. Periodic pruning every 60s, unref'd (cleaner test exit +
// shutdown).
const limiter = new FixedWindowLimiter({
  windowMs: Math.max(USER_RATE_WINDOW_MS, PORTAL_RATE_WINDOW_MS),
  maxKeys: MAX_BUCKETS,
  pruneIntervalMs: 60_000,
});

export function allow(key: string, limit: number, windowMs: number): boolean {
  return limiter.allow(key, limit, windowMs);
}

/**
 * Classify a rate-limit bucket key as per-user vs per-principal (portal).
 *
 * Proxy keys are `oc:<kind>:<id>` (portal / per-principal) or
 * `oc:<kind>:<id>:<userId>` (per-user) — see proxy.ts gate 1c. The trailing
 * userId segment is what distinguishes a per-user bucket, so classify by the
 * colon-segment count: 4+ segments → per-user, exactly 3 → per-principal.
 */
function isUserBucketKey(key: string): boolean {
  return key.split(":").length >= 4;
}

/** Returns counts of active user and portal rate limiters for /stats. */
export function activeRateLimiters(): { activeUserLimiters: number; activePortalLimiters: number } {
  const now = Date.now();
  let activeUserLimiters = 0;
  let activePortalLimiters = 0;
  for (const [key, b] of limiter.entries()) {
    const isUser = isUserBucketKey(key);
    const windowMs = isUser ? USER_RATE_WINDOW_MS : PORTAL_RATE_WINDOW_MS;
    if (now - b.start > windowMs) continue; // expired
    if (isUser) {
      activeUserLimiters++;
    } else {
      activePortalLimiters++;
    }
  }
  return { activeUserLimiters, activePortalLimiters };
}
