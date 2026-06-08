/**
 * In-memory session store for op_session cookies.
 *
 * Replaces the plaintext-password-as-cookie scheme: instead of storing the
 * operator's password in the cookie jar, `createSession()` mints a random
 * opaque token and maps it to an expiry timestamp. `requireAdmin` /
 * `validateSession` then check the token without touching the password.
 *
 * The store is module-level (process lifetime). Sessions are valid for 7 days
 * and are lazily pruned on access so the map does not grow unbounded. Active
 * use renews the session via sliding expiry: `touchSession()` (called from
 * hooks.server.ts on every authenticated request) pushes the expiry back to a
 * full TTL so active operators are never logged out mid-session, while idle
 * sessions still expire after `SESSION_TTL_MS`.
 */

/** Session lifetime — both the in-store expiry and the cookie Max-Age. 7 days. */
export const SESSION_TTL_MS = 604_800_000; // 7 days
/** Cookie Max-Age in seconds (Set-Cookie uses seconds, not ms). */
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

/** token → absolute expiry timestamp (ms since epoch) */
const sessions = new Map<string, number>();

/**
 * Mint a new session token, store it with a 7-day TTL, and return it.
 * The caller is responsible for placing the token in the `op_session` cookie.
 */
export function createSession(): string {
  const token = crypto.randomUUID();
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

/**
 * Return true iff `token` is a known, non-expired session.
 * Expired entries are removed on access.
 */
export function validateSession(token: string): boolean {
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (expiresAt === undefined) return false;
  if (Date.now() >= expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/**
 * Sliding renewal: if `token` is a known, non-expired session, push its expiry
 * back to a full TTL from now and return true. Returns false (no-op) for
 * unknown or already-expired tokens. Cheap — a single map get + set.
 *
 * Callers re-issue the cookie with a fresh Max-Age only when this returns true,
 * keeping active operators signed in while idle sessions still time out.
 */
export function touchSession(token: string): boolean {
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (expiresAt === undefined) return false;
  if (Date.now() >= expiresAt) {
    sessions.delete(token);
    return false;
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return true;
}

/**
 * Remove a session token from the store (used by logout).
 * Safe to call with an unknown token — it's a no-op.
 */
export function invalidateSession(token: string): void {
  sessions.delete(token);
}

/** For tests only — seed a known token and optional clear of the entire map. */
export function _seedSession(token: string, ttlMs = SESSION_TTL_MS): void {
  sessions.set(token, Date.now() + ttlMs);
}

/** For tests only — clear all sessions. */
export function _clearSessions(): void {
  sessions.clear();
}
