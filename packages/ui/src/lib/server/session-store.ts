/**
 * Stateless signed session tokens.
 *
 * Token format: `<expiresAt>.<hmac-sha256-hex>`
 *   expiresAt — unix ms timestamp when the session expires
 *   signature — HMAC-SHA256(expiresAt, login password)
 *
 * Tokens are self-validating: the server holds no per-session state and
 * sessions survive UI server restarts. Signing with the login password means
 * a password change invalidates all existing sessions — correct behaviour.
 *
 * The signing secret is resolved exactly like login verification
 * (`getUiLoginPassword`): `process.env.OP_UI_LOGIN_PASSWORD` first, then the
 * on-disk stack secret. When NEITHER exists, minting throws and validation
 * fails closed — there is deliberately no fallback secret, because a constant
 * key would let anyone forge an admin token. Reading the file per call also
 * means tokens minted right after the setup wizard writes the password are
 * signed with the real secret, without waiting for a process restart.
 *
 * Logout semantics (known trade-off of stateless tokens): logout revokes the
 * single token the browser presented (in-memory list, cleared on restart) and
 * clears the cookie. Earlier tokens issued to the same browser by sliding
 * renewal remain cryptographically valid until they expire — logout is
 * "forget my cookie", not "kill every credential ever issued". A real
 * kill-switch is changing the login password, which invalidates everything.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readSecret, resolveStackDir } from '@openpalm/lib';

/** Session lifetime for both the token expiry and the cookie Max-Age. 14 days. */
export const SESSION_TTL_MS = 1_209_600_000;
/** Cookie Max-Age in seconds (Set-Cookie uses seconds, not ms). */
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

// Small in-memory revocation list for logout. Cleared on server restart.
const _revoked = new Set<string>();
// Test-only bypass set: populated by _seedSession, always empty in production.
const _testOverrides = new Set<string>();

/**
 * Read the operator UI login password from the host environment or the
 * file-based stack secret (`knowledge/secrets/op_ui_login_password`).
 *
 * This is the single source of truth for the password — login verification
 * (helpers.ts) and token signing below both use it, so they can never
 * disagree about whether a password exists. Returns "" when neither source
 * has a value (first boot, before the wizard runs).
 */
export function getUiLoginPassword(): string {
  const envValue = process.env.OP_UI_LOGIN_PASSWORD;
  if (envValue) return envValue;
  return readSecret(resolveStackDir(), 'op_ui_login_password')?.trimEnd() ?? "";
}

/** Sign `expiresAt` with the login password. Returns null when no password is configured. */
function signToken(expiresAt: number): string | null {
  const secret = getUiLoginPassword();
  if (!secret) return null;
  return createHmac('sha256', secret).update(String(expiresAt)).digest('hex');
}

/**
 * Mint a new signed session token with a 14-day TTL.
 * Place the result in the `op_session` cookie.
 * Throws when no login password is configured — callers must verify a
 * password exists (they all do: login/session/setup-complete check first).
 */
export function createSession(): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const sig = signToken(expiresAt);
  if (sig === null) {
    throw new Error('Cannot mint a session: no UI login password is configured.');
  }
  return `${expiresAt}.${sig}`;
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
  if (expected === null) return false; // no password configured → fail closed
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
 * The revocation list survives until the next server restart. Entries whose
 * embedded expiry has passed are pruned on each call — an expired token fails
 * validation anyway, so keeping it listed is pure memory growth.
 */
export function invalidateSession(token: string): void {
  const now = Date.now();
  for (const revoked of _revoked) {
    const expiresAt = Number(revoked.slice(0, revoked.lastIndexOf('.')));
    if (!Number.isFinite(expiresAt) || expiresAt <= now) _revoked.delete(revoked);
  }
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
