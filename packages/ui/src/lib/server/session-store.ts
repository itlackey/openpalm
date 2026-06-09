/**
 * Persistent session store for op_session cookies.
 *
 * Tokens are written to ${dataDir}/admin/sessions.json so they survive UI
 * server restarts (the Electron app killing and respawning the Node child
 * process). Without persistence the browser holds a valid 14-day cookie but
 * the server has no record of it → forced login on every app launch.
 *
 * Sessions are valid for 14 days and are lazily pruned on access. Active use
 * renews the session via sliding expiry: `touchSession()` (called from
 * hooks.server.ts on every authenticated request) pushes the expiry back to a
 * full TTL so active operators are never logged out mid-session, while idle
 * sessions still expire.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Session lifetime — both the in-store expiry and the cookie Max-Age. 14 days. */
export const SESSION_TTL_MS = 1_209_600_000; // 14 days
/** Cookie Max-Age in seconds (Set-Cookie uses seconds, not ms). */
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

/** token → absolute expiry timestamp (ms since epoch) */
const sessions = new Map<string, number>();

// ── Disk persistence ─────────────────────────────────────────────────────────

function sessionFilePath(): string | null {
  const dataDir = process.env.OP_DATA_DIR ?? '';
  if (!dataDir) return null;
  return join(dataDir, 'admin', 'sessions.json');
}

function loadFromDisk(): void {
  const path = sessionFilePath();
  if (!path || !existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, number>;
    const now = Date.now();
    for (const [token, expiresAt] of Object.entries(raw)) {
      if (typeof expiresAt === 'number' && expiresAt > now) {
        sessions.set(token, expiresAt);
      }
    }
  } catch {
    // Corrupt or missing file — start fresh. Not fatal.
  }
}

function saveToDisk(): void {
  const path = sessionFilePath();
  if (!path) return;
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    const obj: Record<string, number> = {};
    for (const [token, expiresAt] of sessions) obj[token] = expiresAt;
    writeFileSync(path, JSON.stringify(obj), { mode: 0o600 });
  } catch {
    // Best-effort. A write failure degrades to the in-memory-only behaviour.
  }
}

// Load persisted sessions eagerly at module init so the first request after
// a UI server restart already finds the live token.
loadFromDisk();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Mint a new session token, store it with a 14-day TTL, and return it.
 * The caller is responsible for placing the token in the `op_session` cookie.
 */
export function createSession(): string {
  const token = crypto.randomUUID();
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  saveToDisk();
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
    saveToDisk();
    return false;
  }
  return true;
}

/**
 * Sliding renewal: push the session expiry back to a full TTL from now.
 * Returns false (no-op) for unknown or already-expired tokens.
 * Callers re-issue the cookie with a fresh Max-Age only when this returns true.
 */
export function touchSession(token: string): boolean {
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (expiresAt === undefined) return false;
  if (Date.now() >= expiresAt) {
    sessions.delete(token);
    saveToDisk();
    return false;
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  saveToDisk();
  return true;
}

/**
 * Remove a session token from the store (used by logout).
 * Safe to call with an unknown token — it's a no-op.
 */
export function invalidateSession(token: string): void {
  sessions.delete(token);
  saveToDisk();
}

/** For tests only — seed a known token and optional clear of the entire map. */
export function _seedSession(token: string, ttlMs = SESSION_TTL_MS): void {
  sessions.set(token, Date.now() + ttlMs);
}

/** For tests only — clear all sessions. */
export function _clearSessions(): void {
  sessions.clear();
}
