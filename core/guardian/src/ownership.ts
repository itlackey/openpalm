/**
 * Guardian-LOCAL session/permission ownership maps for the /oc/* proxy.
 *
 * A principal is (channel, userId). When a principal creates a session through
 * the proxy, the guardian records `sessionId → principal` synchronously on the
 * create response (closing the /event creation race, §3.2 F2b). Later calls on
 * that session (GET/DELETE, message, prompt_async, abort) are authorized
 * against this map; GET /session is filtered to the principal's own sessions.
 *
 * Permission replies are keyed by `requestID` (POST /permission/{requestID}/reply),
 * NOT sessionID — so a parallel `requestID → principal` map is recorded when the
 * guardian relays a `permission.asked` frame (§3.4). The recording happens in the
 * /event fan-out stage (Stage 2); this module exposes the map + assert/record
 * seam now so the proxy can authorize replies once that lands.
 *
 * This mirrors rate-limit.ts exactly: a module-scoped Map (no class, no DI), a
 * `.unref()`'d prune timer, a hard size cap with oldest-first eviction, and a
 * size getter for /stats. It is guardian-local on purpose — NOT @openpalm/lib.
 */

/** The identity that owns a session/permission request. */
export interface Principal {
  id: string;
  kind: 'channel' | 'direct';
  userId: string;
}

/** Stable string key for a principal — used for equality and Map keys. */
export function principalKey(p: Principal): string {
  // userId is opaque (e.g. "discord:123"); principal id is normalized upstream.
  // JSON-encode both segments so a userId containing the delimiter cannot
  // forge another principal's key.
  return JSON.stringify([p.kind, p.id, p.userId]);
}

// TTL mirrors the buffered session cache (forward.ts: GUARDIAN_SESSION_TTL_MS,
// default 15 min). Entries are pruned on TTL, on hard-cap, and on explicit delete.
const OWNERSHIP_TTL_MS = Number(Bun.env.GUARDIAN_SESSION_TTL_MS ?? 15 * 60_000);

/** Hard caps — same discipline as replay.ts (50k) / sessions (10k). */
const SESSION_OWNERS_MAX = 50_000;
const PERMISSION_OWNERS_MAX = 50_000;

type OwnerEntry = { key: string; lastUsed: number };

const sessionOwners = new Map<string, OwnerEntry>();      // sessionId    → principalKey
const permissionOwners = new Map<string, OwnerEntry>();   // requestID    → principalKey

function pruneOwnerMap(map: Map<string, OwnerEntry>, max: number): void {
  const cutoff = Date.now() - OWNERSHIP_TTL_MS;
  for (const [k, v] of map) {
    if (v.lastUsed < cutoff) map.delete(k);
  }
  if (map.size > max) {
    const sorted = [...map.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const toRemove = sorted.slice(0, sorted.length - max);
    for (const [k] of toRemove) map.delete(k);
  }
}

// Periodic pruning every 60s. unref() so the timer never holds the event loop
// open (cleaner test exit + shutdown) — same as replay.ts/rate-limit.ts.
const pruneTimer = setInterval(() => {
  pruneOwnerMap(sessionOwners, SESSION_OWNERS_MAX);
  pruneOwnerMap(permissionOwners, PERMISSION_OWNERS_MAX);
}, 60_000);
pruneTimer.unref();

// ── Session ownership ─────────────────────────────────────────────────────

/** Record that `principal` owns `sessionId`. Called on POST /session create. */
export function recordSessionOwner(sessionId: string, principal: Principal): void {
  sessionOwners.set(sessionId, { key: principalKey(principal), lastUsed: Date.now() });
  if (sessionOwners.size > SESSION_OWNERS_MAX) pruneOwnerMap(sessionOwners, SESSION_OWNERS_MAX);
}

/**
 * Returns true only if `principal` owns `sessionId`. Fail-closed: an unknown
 * (or absent) sessionId returns false. Touches lastUsed on a hit to keep
 * active sessions from being pruned mid-conversation.
 */
export function ownsSession(sessionId: string, principal: Principal): boolean {
  const entry = sessionOwners.get(sessionId);
  if (!entry) return false;
  if (Date.now() - entry.lastUsed > OWNERSHIP_TTL_MS) {
    sessionOwners.delete(sessionId);
    return false;
  }
  if (entry.key !== principalKey(principal)) return false;
  entry.lastUsed = Date.now();
  return true;
}

/** Forget a session's ownership (called after a successful DELETE /session/{id}). */
export function forgetSession(sessionId: string): void {
  sessionOwners.delete(sessionId);
}

/** Returns the set of sessionIds owned by `principal` (for GET /session filtering). */
export function ownedSessionIds(principal: Principal): Set<string> {
  const key = principalKey(principal);
  const now = Date.now();
  const ids = new Set<string>();
  for (const [sessionId, entry] of sessionOwners) {
    if (entry.key === key && now - entry.lastUsed <= OWNERSHIP_TTL_MS) ids.add(sessionId);
  }
  return ids;
}

// ── Permission ownership (recorded at /event relay — Stage 2 seam) ─────────

/**
 * Record that `principal` owns `requestID`. Called when the guardian relays a
 * `permission.asked` frame to that principal (§3.4). Wired in Stage 2; exposed
 * now so the proxy can authorize POST /permission/{requestID}/reply.
 */
export function recordPermissionOwner(requestID: string, principal: Principal): void {
  permissionOwners.set(requestID, { key: principalKey(principal), lastUsed: Date.now() });
  if (permissionOwners.size > PERMISSION_OWNERS_MAX) pruneOwnerMap(permissionOwners, PERMISSION_OWNERS_MAX);
}

/**
 * Returns true only if `principal` owns `requestID`. Fail-closed on unknown id.
 *
 * NOTE (Stage 1): until the /event relay (Stage 2) records requestID→principal,
 * NO requestID is ever recorded, so this returns false for every reply — the
 * proxy must therefore treat permission-reply ownership as not-yet-enforceable
 * and deny (fail-closed) rather than allow. See the proxy's handling of
 * /permission/{requestID}/reply.
 */
export function ownsPermission(requestID: string, principal: Principal): boolean {
  const entry = permissionOwners.get(requestID);
  if (!entry) return false;
  if (Date.now() - entry.lastUsed > OWNERSHIP_TTL_MS) {
    permissionOwners.delete(requestID);
    return false;
  }
  return entry.key === principalKey(principal);
}

// ── /stats + test helpers ──────────────────────────────────────────────────

/** Active owned-session count for the /stats endpoint. */
export function sessionOwnerCount(): number {
  return sessionOwners.size;
}

/** Active owned-permission-request count for the /stats endpoint. */
export function permissionOwnerCount(): number {
  return permissionOwners.size;
}

export { OWNERSHIP_TTL_MS, SESSION_OWNERS_MAX, PERMISSION_OWNERS_MAX };

/** Test-only: clear both maps between cases. */
export function _resetOwnershipForTest(): void {
  sessionOwners.clear();
  permissionOwners.clear();
}
