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
 * (`getUiLoginPassword`): the on-disk stack secret first, live (mtime/size
 * cached), then `process.env.OP_UI_LOGIN_PASSWORD` as a fallback for when no
 * file exists yet. When NEITHER exists, minting throws and validation fails
 * closed — there is deliberately no fallback secret, because a constant key
 * would let anyone forge an admin token. Reading the file live (not just at
 * process spawn) also means a password change — whether from the setup
 * wizard, `openpalm reset-password`, or a hand edit — takes effect on the
 * very next request, without waiting for a process/container restart.
 *
 * Logout semantics (known trade-off of stateless tokens): logout revokes the
 * single token the browser presented (in-memory list, cleared on restart) and
 * clears the cookie. Earlier tokens issued to the same browser by sliding
 * renewal remain cryptographically valid until they expire — logout is
 * "forget my cookie", not "kill every credential ever issued". A real
 * kill-switch is changing the login password, which invalidates everything.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import { ensureSecret, readSecret, resolveOpenPalmHome, secretPath } from '@openpalm/lib';

/** File secret holding the server-side session signing key. */
const SESSION_KEY_SECRET = 'op_session_signing_key';
/** File secret holding the UI login password (C3: the authoritative source). */
const LOGIN_PASSWORD_SECRET = 'op_ui_login_password';

/**
 * mtime/size-cached read of the login password secret file, so a live read
 * of the authoritative source doesn't cost a disk hit on every request while
 * still picking up a change (reset-password, hand edit) on the very next
 * call. `secretPath` is a pure path join (no I/O), so the cheap `statSync`
 * below is the only per-request disk touch on the cache-hit path; the fuller
 * `readSecret` (which also hardens directory/file permissions) only runs
 * when the file has actually changed. `secretPath` name-routes delegated
 * secrets (op_ui_login_password among them) to `private/secrets` (G1), so the
 * stat and the read below always agree on the location.
 */
let passwordFileCache: { mtimeMs: number; size: number; value: string } | undefined;

function readLivePasswordFile(): string {
  const path = secretPath(resolveOpenPalmHome(), LOGIN_PASSWORD_SECRET);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    // File absent (or dir absent) — nothing cached to serve.
    passwordFileCache = undefined;
    return '';
  }
  if (
    passwordFileCache &&
    passwordFileCache.mtimeMs === stat.mtimeMs &&
    passwordFileCache.size === stat.size
  ) {
    return passwordFileCache.value;
  }
  const value = readSecret(resolveOpenPalmHome(), LOGIN_PASSWORD_SECRET)?.trimEnd() ?? '';
  passwordFileCache = { mtimeMs: stat.mtimeMs, size: stat.size, value };
  return value;
}

/** Session lifetime for both the token expiry and the cookie Max-Age. 14 days. */
export const SESSION_TTL_MS = 1_209_600_000;
/** Cookie Max-Age in seconds (Set-Cookie uses seconds, not ms). */
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

// Small in-memory revocation list for logout. Cleared on server restart.
const _revoked = new Set<string>();
// Test-only bypass set: populated by _seedSession, always empty in production.
const _testOverrides = new Set<string>();

/**
 * Read the operator UI login password from the file-based stack secret
 * (`private/secrets/op_ui_login_password` — a delegated secret, relocated out
 * of the assistant-reachable stash by G1), falling back to
 * `process.env.OP_UI_LOGIN_PASSWORD` only when no secret file exists yet.
 *
 * The file is authoritative (C3): it is bind-mounted live and read fresh on
 * every call (mtime/size-cached — see `readLivePasswordFile`), so a password
 * change takes effect on the very next request with no process/container
 * restart. The env var exists only as a bootstrap fallback for the narrow
 * window before the file has ever been written.
 *
 * This is the single source of truth for the password — login verification
 * (helpers.ts) and token signing below both use it, so they can never
 * disagree about whether a password exists. Returns "" when neither source
 * has a value (first boot, before the wizard runs).
 */
export function getUiLoginPassword(): string {
  // The assistant container's UI co-process is the exception, and it must fail
  // CLOSED to its injected value. In that process `resolveOpenPalmHome()`
  // resolves inside the agent-writable data mount (no host OP_HOME is
  // injected), so a file-first read lets any write under
  // `private/secrets/op_ui_login_password` there — by the agent, a restored
  // backup, or a misbehaving plugin — silently replace the operator's LAN
  // login password, with no diagnostic beyond "my password stopped working".
  // The compose secret is the only authority for this process; the same
  // fail-closed treatment `OP_UI_NO_LOCAL_VOICE` already gives voice.
  if (process.env.OP_UI_SERVED_IN_CONTAINER === '1') {
    return process.env.OP_UI_LOGIN_PASSWORD ?? '';
  }
  const fileValue = readLivePasswordFile();
  if (fileValue) return fileValue;
  return process.env.OP_UI_LOGIN_PASSWORD ?? "";
}

/**
 * Resolve the HMAC key for session signing.
 *
 * The key is `HMAC(serverKey, sha256(loginPassword))`, where `serverKey` is a
 * 256-bit random value generated once and stored beside the other file
 * secrets. It is deliberately NOT the login password itself.
 *
 * Signing directly with the plaintext password (the previous behaviour) made
 * every cookie an offline oracle for it: the token is
 * `<expiresAt>.<HMAC(expiresAt, password)>`, so the signed message ships in
 * cleartext alongside its own signature — a known-plaintext pair crackable at
 * one HMAC-SHA256 per guess, with no KDF and no salt. Anyone who captured a
 * cookie could recover the password offline, and the password is the master
 * credential for the whole stack. Mixing in a server-side key means an
 * attacker holding a cookie has nothing to brute-force against.
 *
 * Hashing the password into the key preserves the original, deliberate
 * property that changing the password invalidates every existing session.
 *
 * Returns null when no password is configured, or when the secret store is
 * unreachable — minting and validation both fail closed rather than falling
 * back to a weaker key.
 *
 * `op_session_signing_key` is a DELEGATED secret (secrets-files.ts), so
 * `ensureSecret` name-routes it to `private/secrets`, which is never mounted
 * into the assistant. It was missed when the other delegated secrets moved
 * there, leaving it under `knowledge/secrets` — bind-mounted into the assistant
 * at `/stash`. Combined with the login password the same mount exposed, that
 * made a host-admin session cookie forgeable from inside the container, which
 * is exactly what mixing in a server key is supposed to prevent.
 */
function sessionSigningKey(): Buffer | null {
  const password = getUiLoginPassword();
  if (!password) return null;
  let serverKey: string;
  try {
    serverKey = ensureSecret(resolveOpenPalmHome(), SESSION_KEY_SECRET, () =>
      `${randomBytes(32).toString('hex')}\n`,
    ).trim();
  } catch {
    return null;
  }
  if (!serverKey) return null;
  const passwordDigest = createHash('sha256').update(password).digest();
  return createHmac('sha256', serverKey).update(passwordDigest).digest();
}

/** Sign `expiresAt`. Returns null when no signing key can be resolved. */
function signToken(expiresAt: number): string | null {
  const key = sessionSigningKey();
  if (!key) return null;
  return createHmac('sha256', key).update(String(expiresAt)).digest('hex');
}

/**
 * Mint a new signed session token, 14 days by default.
 * Place the result in the `op_session` cookie.
 * Throws when no login password is configured — callers must verify a
 * password exists (they all do: login/session/setup-complete check first).
 *
 * `ttlMs` exists for the workspace ticket (server/workspace-ticket.ts), which
 * is the same credential with a one-minute life because it travels in a URL
 * rather than a cookie. Keeping it as a parameter here — rather than a second
 * token format — means the ticket is verified by the SAME `validateSession`
 * everything else uses, so there is no second way to authenticate.
 */
export function createSession(ttlMs: number = SESSION_TTL_MS): string {
  const expiresAt = Date.now() + ttlMs;
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
