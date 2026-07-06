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
 * secondary to HTTP Basic + sha256 auth), but could be upgraded to a sliding
 * window if needed.
 */

import { FixedWindowLimiter } from "./bounded-map";

export const USER_RATE_LIMIT = 120;
export const USER_RATE_WINDOW_MS = 60_000;
export const PORTAL_RATE_LIMIT = 200;
export const PORTAL_RATE_WINDOW_MS = 60_000;

// Coarse per-source-IP budget applied BEFORE authenticate() (rev3-F3). It exists
// only to blunt credential-stuffing and body-flood from a single source, so it is
// deliberately generous — the authenticated per-user / per-portal limits above
// stay authoritative for legitimate traffic.
export const PREAUTH_RATE_LIMIT = 600;
export const PREAUTH_RATE_WINDOW_MS = 60_000;

const USER_BUCKET_PREFIX = "user:";
const PORTAL_BUCKET_PREFIX = "portal:";

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

// Separate limiter instance for the pre-auth per-IP budget so its buckets never
// pollute the user/portal counts activeRateLimiters() reports.
const preAuthLimiter = new FixedWindowLimiter({
  windowMs: PREAUTH_RATE_WINDOW_MS,
  maxKeys: MAX_BUCKETS,
  pruneIntervalMs: 60_000,
});

/**
 * Coarse per-IP admission check, called before authenticate() so a single source
 * cannot credential-stuff or body-flood the pipeline. An empty `clientIp` (socket
 * address unavailable) is not limited — the authenticated limiters remain the
 * authoritative control.
 */
export function allowPreAuth(clientIp: string): boolean {
  if (!clientIp) return true;
  return preAuthLimiter.allow(`ip:${clientIp}`, PREAUTH_RATE_LIMIT, PREAUTH_RATE_WINDOW_MS);
}

/**
 * Classify a rate-limit bucket key as per-user vs per-principal (portal).
 *
 * New buckets use an explicit prefix (`user:` / `portal:`) so classification is
 * not tied to the number of `:` segments in the bucket key. Legacy `oc:` keys
 * keep working via the old segment-count heuristic.
 */
function isUserBucketKey(key: string): boolean {
  if (key.startsWith(USER_BUCKET_PREFIX)) {
    return true;
  }
  if (key.startsWith(PORTAL_BUCKET_PREFIX)) {
    return false;
  }
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
