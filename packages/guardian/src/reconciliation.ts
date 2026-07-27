/**
 * Orphan-session reconciliation sweep (S4, #581 finding #7; lifecycle-aware
 * redesign #586).
 *
 * `session_owners` (state-db.ts) is a BOUNDED table: past
 * GUARDIAN_OWNERSHIP_MAX_ROWS it evicts its oldest-IDLE row on every insert.
 * Before this module existed, that eviction simply deleted the ownership
 * row — but the underlying OpenCode session is durable upstream and does NOT
 * go away with it. The result was a permanent, undeletable orphan: no
 * principal could ever list it again (GET /session is filtered to owned
 * rows) or delete it (DELETE /session/{id} 403s forbidden_session with no
 * owner on record), yet it stayed on disk forever.
 *
 * Eviction persists a `session_eviction_log` row FIRST, synchronously, in the
 * same call as the ownership-row delete (state-db.ts's
 * evictOldestSessionOwners) — cheap, all-SQL, on the hot session-create
 * request path. This module is the async SECOND half: an out-of-band sweep
 * that walks the pending log entries and, for each, VERIFIES upstream
 * activity before acting (#586 Fix A — see verifyThenDeleteUpstreamSession):
 * a session confirmed gone or stale gets deleted/archived; a session
 * confirmed still active gets its ownership row RESTORED (un-evicted, decision
 * 586-1) rather than destroyed; anything uncertain is left pending for the
 * next pass. Decoupled from the hot path so a slow/unavailable assistant
 * never blocks a portal turn.
 *
 * `deleteUpstreamSession` is injected (rather than hardcoding a `fetch` call)
 * so {@link reconcileEvictedSessions} stays unit-testable without a live
 * OpenCode server; {@link deleteUpstreamSessionViaAssistant} (built on
 * {@link verifyThenDeleteUpstreamSession}) is the real implementation
 * server.ts wires up for the periodic sweep, via {@link drainEvictedSessions}.
 */

import type { Database } from 'bun:sqlite';
import { createLogger } from './logger.ts';
import { ASSISTANT_URL, SESSION_ACTIVE_GRACE_MS, withAssistantUpstreamAuth } from './config.ts';
import { listPendingEvictedSessions, markSessionReconciled, restoreSessionOwnerRow } from './state-db.ts';

const logger = createLogger('guardian:reconciliation');

/**
 * Outcome of verifying/deleting one evicted session upstream (#586 Fix A):
 *   - 'deleted': confirmed gone upstream (DELETE succeeded, or the initial
 *     GET already 404'd) — a durable resolution, log row marked reconciled.
 *   - 'active': the session is recently active upstream — the caller
 *     restores (un-evicts) the ownership row (decision 586-1) rather than
 *     merely deferring; ALSO a durable resolution (marked reconciled), just
 *     via restoration instead of deletion.
 *   - 'failed': genuinely uncertain (network error, non-2xx/unparsable GET,
 *     a failed DELETE) — fail-safe: the row is left pending for the next
 *     sweep, never destroyed on uncertainty.
 */
export type UpstreamSessionOutcome = 'deleted' | 'active' | 'failed';

export interface ReconcileResult {
  /** Pending rows the sweep looked at this pass (bounded by `limit`). */
  attempted: number;
  /** Confirmed deleted/archived upstream — marked reconciled. */
  reconciled: number;
  /**
   * Confirmed ACTIVE upstream and restored (un-evicted) — a resolved,
   * non-failure outcome distinct from both `reconciled` (deleted) and
   * `failed` (uncertain). Must never be logged as an assistant failure, and
   * must never stop {@link drainEvictedSessions}'s multi-batch loop.
   */
  deferred: number;
  /** Left pending for the next pass (network error, non-2xx response, a failed DELETE, etc). */
  failed: number;
}

/**
 * Walk up to `limit` pending evicted sessions, oldest first, and call
 * `deleteUpstreamSession` for each. 'deleted' marks the row reconciled;
 * 'active' restores the ownership row AND marks it reconciled (decision
 * 586-1 — a resolved outcome, not a retry); 'failed' (thrown error included)
 * leaves it pending so the next sweep retries it — reconciliation only ever
 * narrows the orphan set, it never gives up and drops a row on the floor.
 *
 * `database` is an explicit optional override, defaulting to the module
 * singleton via the SAME test seam state-db.ts's own accessors use (a raw
 * `bun:sqlite` `Database`, never threaded through env) — it exists so this
 * function is unit-testable against a throwaway temp DB rather than the
 * env-bound singleton (unsafe to exercise across test files in-process, see
 * state-db.test.ts).
 */
export async function reconcileEvictedSessions(
  deleteUpstreamSession: (sessionId: string) => Promise<UpstreamSessionOutcome>,
  limit = 100,
  database?: Database,
): Promise<ReconcileResult> {
  const pending = database ? listPendingEvictedSessions(limit, database) : listPendingEvictedSessions(limit);
  let reconciled = 0;
  let deferred = 0;
  let failed = 0;

  for (const row of pending) {
    let outcome: UpstreamSessionOutcome;
    try {
      outcome = await deleteUpstreamSession(row.sessionId);
    } catch (err) {
      outcome = 'failed';
      logger.warn('session_reconcile_error', { sessionId: row.sessionId, error: String(err) });
    }
    if (outcome === 'deleted') {
      if (database) markSessionReconciled(row.sessionId, database);
      else markSessionReconciled(row.sessionId);
      reconciled += 1;
    } else if (outcome === 'active') {
      if (database) restoreSessionOwnerRow(row.sessionId, row.principalKey, Date.now(), database);
      else restoreSessionOwnerRow(row.sessionId, row.principalKey);
      deferred += 1;
    } else {
      failed += 1;
    }
  }

  if (pending.length > 0) {
    logger.info('session_reconcile_sweep', { attempted: pending.length, reconciled, deferred, failed });
  }
  return { attempted: pending.length, reconciled, deferred, failed };
}

/**
 * Loop {@link reconcileEvictedSessions} across successive `batch`-sized
 * passes until the pending backlog is drained (Fix B, #586) — continuing a
 * single sweep across an arbitrarily large backlog rather than the old
 * single-batch call, so a big backlog recovers in one call once the
 * assistant is reachable again (AC2). Stops when either:
 *   - a pass returns any `failed` row — never hammer a down assistant; or
 *   - a pass returns fewer than `batch` attempted — the pending queue is
 *     exhausted for this drain.
 * A `deferred` (active-session) result does NOT stop the loop: it is
 * resolved (restored), not a failure, so later batches still get a chance.
 */
export async function drainEvictedSessions(
  deleteUpstreamSession: (sessionId: string) => Promise<UpstreamSessionOutcome>,
  batch = 100,
  database?: Database,
): Promise<ReconcileResult> {
  let attempted = 0;
  let reconciled = 0;
  let deferred = 0;
  let failed = 0;

  for (;;) {
    const result = database
      ? await reconcileEvictedSessions(deleteUpstreamSession, batch, database)
      : await reconcileEvictedSessions(deleteUpstreamSession, batch);
    attempted += result.attempted;
    reconciled += result.reconciled;
    deferred += result.deferred;
    failed += result.failed;
    if (result.failed > 0) break; // never hammer a down assistant
    if (result.attempted < batch) break; // pending backlog exhausted for this pass
  }

  return { attempted, reconciled, deferred, failed };
}

/**
 * Verify a session's upstream activity before deleting it (Fix A step 4,
 * decision 586-1). Before this, evicted rows went straight to an upstream
 * DELETE with no activity check — an active conversation could be destroyed
 * mid-use, since the guardian only sees traffic THROUGH the proxy and a
 * session kept alive via the OpenCode web UI (:4096) is invisible to it.
 * `GET /session/{id}` first:
 *   - 404 ⇒ already gone upstream — 'deleted' (no DELETE call needed).
 *   - 200 with a RECENT `time.updated` (within `activeGraceMs`) ⇒ 'active' —
 *     the caller restores the ownership row rather than deleting anything.
 *   - 200, stale ⇒ safe to delete; issue the DELETE and report its outcome.
 *   - any other status, network error, unparsable body, OR a 200 body whose
 *     `time.updated` is missing/non-numeric (`Number(...)` not finite) ⇒
 *     'failed' (fail-safe: never destroy on uncertainty — this is exactly the
 *     schema-coupling risk called out below: if OpenCode ever renames/retypes
 *     `time.updated`, every pending row must defer, never delete).
 *
 * This is roughly the FOURTH OpenCode schema-coupling point in this package
 * (after proxy.ts's request-body parsing, forwardSessionCreate/
 * forwardSessionList response parsing, and the event-frame shapes) —
 * `Session.time.{created,updated}` is confirmed in the vendored SDK typegen.
 * The OpenCode version itself is pinned via the `opencode-ai` dependency in
 * containers/{assistant,guardian}/tools/package.json (no `OPENCODE_VERSION`
 * Dockerfile ARG exists); keep this parsing in lockstep with that pin if
 * OpenCode changes the session response shape.
 */
export async function verifyThenDeleteUpstreamSession(
  baseUrl: string,
  sessionId: string,
  activeGraceMs: number,
  fetchLike: typeof fetch = fetch,
): Promise<UpstreamSessionOutcome> {
  const url = `${baseUrl}/session/${encodeURIComponent(sessionId)}`;

  let response: Response;
  try {
    response = await fetchLike(url, { headers: withAssistantUpstreamAuth(new Headers()) });
  } catch (err) {
    logger.warn('session_verify_error', { sessionId, error: String(err) });
    return 'failed';
  }

  if (response.status === 404) return 'deleted'; // already gone upstream
  if (!response.ok) return 'failed'; // fail-safe: never destroy on uncertainty

  let session: unknown;
  try {
    session = await response.json();
  } catch {
    return 'failed'; // unparsable body — fail-safe defer
  }

  const updatedAt = Number((session as { time?: { updated?: unknown } } | null)?.time?.updated);
  if (!Number.isFinite(updatedAt)) return 'failed'; // unparsable/missing time.updated — fail-safe defer, never delete on uncertainty
  if (Date.now() - updatedAt <= activeGraceMs) {
    return 'active';
  }

  try {
    const del = await fetchLike(url, { method: 'DELETE', headers: withAssistantUpstreamAuth(new Headers()) });
    return del.ok || del.status === 404 ? 'deleted' : 'failed';
  } catch (err) {
    logger.warn('session_delete_error', { sessionId, error: String(err) });
    return 'failed';
  }
}

/**
 * Real upstream verify-then-delete: bypasses the `/oc` proxy entirely — by
 * the time a session is evicted its ownership row is already gone, so the
 * proxy's `ownsSession` check would 403 it (correctly, for a normal caller;
 * wrongly, for this sweep, which acts with the guardian's own authority, not
 * a principal's).
 */
export async function deleteUpstreamSessionViaAssistant(sessionId: string): Promise<UpstreamSessionOutcome> {
  return verifyThenDeleteUpstreamSession(ASSISTANT_URL, sessionId, SESSION_ACTIVE_GRACE_MS);
}
