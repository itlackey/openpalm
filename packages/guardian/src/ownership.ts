/**
 * Guardian /oc/* session/permission ownership — persisted in the guardian state
 * DB so it SURVIVES a restart.
 *
 * A principal is (kind, id, userId). When a principal creates a session through
 * the proxy, the guardian records `sessionId → principal` synchronously on the
 * create response (closing the /event creation race, §3.2 F2b). Later calls on
 * that session (GET/DELETE, message, prompt_async, abort, history) are authorized
 * against this record; GET /session is filtered to the principal's own sessions.
 *
 * Permission replies are keyed by `requestID` (POST /permission/{requestID}/reply),
 * NOT sessionID — so a parallel `requestID → principal` record is written when the
 * guardian relays a `permission.asked` / `question.asked` frame (§3.4) in the
 * /event relay stage.
 *
 * PREVIOUSLY these lived in module-scoped Maps that were LOST on every guardian
 * restart, orphaning every live conversation (each follow-up call 403'd
 * forbidden_session, and permission replies could never be authorized). They now
 * live in the `session_owners` / `permission_owners` tables (state-db.ts), keyed
 * by the same stable principal key, so a restarted guardian still recognises what
 * its principals own. Fail-closed on unknown ids is preserved.
 */

import {
  recordSessionOwnerRow,
  getSessionOwnerKey,
  deleteSessionOwnerRow,
  listOwnedSessionIds,
  countSessionOwners,
  recordPermissionOwnerRow,
  getPermissionOwnerKey,
  countPermissionOwners,
  clearOwnershipTables,
} from './state-db.ts';

/** The identity that owns a session/permission request. */
export interface Principal {
  id: string;
  kind: 'portal' | 'direct';
  userId: string;
}

/** Stable string key for a principal — used for equality and row keys. */
export function principalKey(p: Principal): string {
  // userId is opaque (e.g. "discord:123"); principal id is normalized upstream.
  // JSON-encode both segments so a userId containing the delimiter cannot
  // forge another principal's key.
  return JSON.stringify([p.kind, p.id, p.userId]);
}

// ── Session ownership ─────────────────────────────────────────────────────

/** Record that `principal` owns `sessionId`. Called on POST /session create. */
export function recordSessionOwner(sessionId: string, principal: Principal): void {
  recordSessionOwnerRow(sessionId, principalKey(principal), Date.now());
}

/**
 * Returns true only if `principal` owns `sessionId`. Fail-closed: an unknown
 * (or absent) sessionId returns false.
 */
export function ownsSession(sessionId: string, principal: Principal): boolean {
  const ownerKey = getSessionOwnerKey(sessionId);
  if (ownerKey === null) return false;
  return ownerKey === principalKey(principal);
}

/**
 * Returns true only if `sessionId` is currently owned by a DIFFERENT principal.
 * Fail-open for reuse decisions: an unknown/unowned session returns false (safe
 * to claim). Used to refuse re-pointing an already-owned session to a new
 * principal (which would silently steal it).
 */
export function sessionOwnedByOther(sessionId: string, principal: Principal): boolean {
  const ownerKey = getSessionOwnerKey(sessionId);
  if (ownerKey === null) return false;
  return ownerKey !== principalKey(principal);
}

/** Forget a session's ownership (called after a successful DELETE /session/{id}). */
export function forgetSession(sessionId: string): void {
  deleteSessionOwnerRow(sessionId);
}

/** Returns the set of sessionIds owned by `principal` (for GET /session filtering). */
export function ownedSessionIds(principal: Principal): Set<string> {
  return new Set(listOwnedSessionIds(principalKey(principal)));
}

// ── Permission ownership (recorded at /event relay) ─────────────────────────

/**
 * Record that `principal` owns `requestID`. Called when the guardian relays a
 * `permission.asked` / `question.asked` frame to that principal (§3.4) so a later
 * POST /permission/{requestID}/reply (or /question/{requestID}/reply|reject) can
 * be authorized.
 */
export function recordPermissionOwner(requestID: string, principal: Principal): void {
  recordPermissionOwnerRow(requestID, principalKey(principal), Date.now());
}

/**
 * Returns true only if `principal` owns `requestID`. Fail-closed on unknown id:
 * a reply for an unrelayed/foreign requestID is denied (principal A cannot answer
 * principal B's request).
 */
export function ownsPermission(requestID: string, principal: Principal): boolean {
  const ownerKey = getPermissionOwnerKey(requestID);
  if (ownerKey === null) return false;
  return ownerKey === principalKey(principal);
}

// ── /stats + test helpers ──────────────────────────────────────────────────

/** Active owned-session count for the /stats endpoint. */
export function sessionOwnerCount(): number {
  return countSessionOwners();
}

/** Active owned-permission-request count for the /stats endpoint. */
export function permissionOwnerCount(): number {
  return countPermissionOwners();
}

/** Test-only: clear both ownership tables between cases. */
export function _resetOwnershipForTest(): void {
  clearOwnershipTables();
}
