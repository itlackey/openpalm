/**
 * Failed-login throttling for `POST /api/auth/login`.
 *
 * The login wall is the ONLY credential boundary once the UI is reachable from
 * anything but loopback, and it had no attempt counter, backoff, or lockout.
 * The setup wizard pre-fills a 128-bit generated password, but
 * `setup-validation.ts` accepts any operator-typed replacement of 8+
 * characters — so an unthrottled endpoint is an open brute-force target for
 * every device on the network.
 *
 * Deliberately in-memory and per-process:
 *   - it guards a single-password login, not a user table, so there is no
 *     durable state worth persisting;
 *   - a restart clearing the counters is acceptable (an attacker cannot force
 *     a restart), and is preferable to a disk write on every failed attempt.
 *
 * Keyed by client address. Behind a reverse proxy every request may share one
 * address, which makes the throttle global rather than per-client — that
 * degrades availability under attack, never security, and is the correct
 * trade-off for a fail-closed credential check.
 */

/** Failures allowed at full speed before backoff engages. */
const FREE_ATTEMPTS = 5;
/** First backoff step; doubles per failure beyond FREE_ATTEMPTS. */
const BASE_DELAY_MS = 1_000;
/** Backoff ceiling — 15 minutes. */
const MAX_DELAY_MS = 15 * 60 * 1_000;
/** A key idle this long is forgotten (and its failure count reset). */
const IDLE_RESET_MS = 15 * 60 * 1_000;
/** Hard cap on tracked keys, so a spoofed-address flood cannot grow the map. */
const MAX_TRACKED_KEYS = 10_000;

type Attempt = { failures: number; blockedUntil: number; lastSeen: number };

const attempts = new Map<string, Attempt>();

/** Test seam so suites can start from a known state. */
export function _resetLoginThrottle(): void {
  attempts.clear();
}

function prune(now: number): void {
  for (const [key, entry] of attempts) {
    if (now - entry.lastSeen > IDLE_RESET_MS && now >= entry.blockedUntil) {
      attempts.delete(key);
    }
  }
  // Still oversized after pruning (sustained flood): drop the least recently
  // seen entries. Evicting a *blocked* key would hand an attacker a reset, so
  // prefer evicting idle ones first.
  if (attempts.size > MAX_TRACKED_KEYS) {
    const ordered = [...attempts.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [key] of ordered.slice(0, attempts.size - MAX_TRACKED_KEYS)) {
      attempts.delete(key);
    }
  }
}

/**
 * Backoff for the Nth failure. Flat until FREE_ATTEMPTS, then doubling from
 * BASE_DELAY_MS, capped at MAX_DELAY_MS.
 */
export function backoffMsForFailures(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  const step = failures - FREE_ATTEMPTS;
  return Math.min(BASE_DELAY_MS * 2 ** step, MAX_DELAY_MS);
}

/**
 * Whether `key` may attempt a login right now. When blocked, `retryAfterSec`
 * is the value to send in `Retry-After` (always at least 1, since a 0 would
 * read as "retry immediately").
 */
export function checkLoginThrottle(
  key: string,
  now: number = Date.now(),
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  const entry = attempts.get(key);
  if (!entry) return { allowed: true };
  if (now - entry.lastSeen > IDLE_RESET_MS && now >= entry.blockedUntil) {
    attempts.delete(key);
    return { allowed: true };
  }
  if (now < entry.blockedUntil) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)) };
  }
  return { allowed: true };
}

/** Record a rejected password and arm the next backoff window. */
export function recordLoginFailure(key: string, now: number = Date.now()): void {
  prune(now);
  const entry = attempts.get(key) ?? { failures: 0, blockedUntil: 0, lastSeen: now };
  // An idle key starts over rather than resuming an hours-old count.
  if (now - entry.lastSeen > IDLE_RESET_MS) entry.failures = 0;
  entry.failures += 1;
  entry.lastSeen = now;
  entry.blockedUntil = now + backoffMsForFailures(entry.failures);
  attempts.set(key, entry);
}

/** Clear the counter for `key` after a successful login. */
export function clearLoginAttempts(key: string): void {
  attempts.delete(key);
}
