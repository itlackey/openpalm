/**
 * In-memory session store for op_session cookies.
 *
 * Replaces the plaintext-password-as-cookie scheme: instead of storing the
 * operator's password in the cookie jar, `createSession()` mints a random
 * opaque token and maps it to an expiry timestamp. `requireAdmin` /
 * `validateSession` then check the token without touching the password.
 *
 * The store is module-level (process lifetime). Sessions are valid for 24 h
 * and are lazily pruned on access so the map does not grow unbounded.
 */

const SESSION_TTL_MS = 86_400_000; // 24 hours

/** token → absolute expiry timestamp (ms since epoch) */
const sessions = new Map<string, number>();

/**
 * Mint a new session token, store it with a 24-hour TTL, and return it.
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
 * Remove a session token from the store (used by logout).
 * Safe to call with an unknown token — it's a no-op.
 */
export function invalidateSession(token: string): void {
  sessions.delete(token);
}
