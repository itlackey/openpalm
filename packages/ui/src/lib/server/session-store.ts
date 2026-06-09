/**
 * Stateless signed session tokens.
 *
 * Token format: `<expiresAt>.<hmac-sha256-hex>`
 *   expiresAt — unix ms timestamp when the session expires
 *   signature — HMAC-SHA256(expiresAt, OP_UI_LOGIN_PASSWORD)
 *
 * Tokens are self-validating: the server holds no state and sessions survive
 * UI server restarts without any disk I/O. Signing with the login password
 * means a password change invalidates all existing sessions — correct behaviour.
 *
 * Logout adds the token to a small in-memory revocation list. That list is
 * cleared on server restart, which is acceptable: nobody holds a just-logged-out
 * token across a restart.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Session lifetime for both the token expiry and the cookie Max-Age. 14 days. */
export const SESSION_TTL_MS = 1_209_600_000;
/** Cookie Max-Age in seconds (Set-Cookie uses seconds, not ms). */
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

// Small in-memory revocation list for logout. Cleared on server restart.
const _revoked = new Set<string>();
// Test-only bypass set: populated by _seedSession, always empty in production.
const _testOverrides = new Set<string>();

function getSecret(): string {
  return process.env.OP_UI_LOGIN_PASSWORD ?? 'no-secret-set';
}

function signToken(expiresAt: number): string {
  return createHmac('sha256', getSecret()).update(String(expiresAt)).digest('hex');
}

/**
 * Mint a new signed session token with a 14-day TTL.
 * Place the result in the `op_session` cookie.
 */
export function createSession(): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  return `${expiresAt}.${signToken(expiresAt)}`;
}

/**
 * Return true iff `token` is a valid, non-expired, non-revoked session.
 */
export function validateSession(token: string): boolean {
  if (!token) return false;
  if (_testOverrides.has(token)) return true;
  if (_revoked.has(token)) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return false;
  const sig = token.slice(dot + 1);
  const expected = signToken(expiresAt);
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

/**
 * Sliding renewal: validate the old token, return a new one with a fresh
 * 14-day TTL, or return false if the old token is invalid/expired.
 * The caller must place the returned token in the `op_session` cookie.
 */
export function touchSession(token: string): string | false {
  if (!validateSession(token)) return false;
  return createSession();
}

/**
 * Revoke a token (logout). The browser cookie must also be cleared by the caller.
 * The revocation list survives until the next server restart.
 */
export function invalidateSession(token: string): void {
  _revoked.add(token);
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** For tests only — seed an arbitrary string as a valid token. */
export function _seedSession(token: string, ttlMs = SESSION_TTL_MS): void {
  if (ttlMs <= 0) return; // negative TTL = intentionally expired; leave it out so validateSession returns false
  _testOverrides.add(token);
}

/** For tests only — clear all overrides and revocations. */
export function _clearSessions(): void {
  _revoked.clear();
  _testOverrides.clear();
}
