/**
 * Orphan-session reconciliation sweep (S4, #581 finding #7).
 *
 * `session_owners` (state-db.ts) is a BOUNDED table: past
 * GUARDIAN_OWNERSHIP_MAX_ROWS it evicts its oldest row on every insert. Before
 * this module existed, that eviction simply deleted the ownership row — but
 * the underlying OpenCode session is durable upstream and does NOT go away
 * with it. The result was a permanent, undeletable orphan: no principal could
 * ever list it again (GET /session is filtered to owned rows) or delete it
 * (DELETE /session/{id} 403s forbidden_session with no owner on record), yet
 * it stayed on disk forever, indistinguishable from any other unbounded-growth
 * leak this report's S-series is about.
 *
 * Eviction now persists a `session_eviction_log` row FIRST, synchronously, in
 * the same call as the ownership-row delete (state-db.ts's
 * evictOldestSessionOwners) — cheap, all-SQL, on the hot session-create
 * request path. This module is the async SECOND half: an out-of-band sweep
 * that walks the pending log entries and actually deletes/archives each
 * session upstream, decoupled from that hot path so a slow/unavailable
 * assistant never blocks a portal turn.
 *
 * `deleteUpstreamSession` is injected (rather than hardcoding a `fetch` call)
 * so {@link reconcileEvictedSessions} stays unit-testable without a live
 * OpenCode server; {@link deleteUpstreamSessionViaAssistant} is the real
 * implementation server.ts wires up for the periodic sweep.
 */

import type { Database } from 'bun:sqlite';
import { createLogger } from './logger.ts';
import { ASSISTANT_URL, withAssistantUpstreamAuth } from './config.ts';
import { listPendingEvictedSessions, markSessionReconciled } from './state-db.ts';

const logger = createLogger('guardian:reconciliation');

export interface ReconcileResult {
  /** Pending rows the sweep looked at this pass (bounded by `limit`). */
  attempted: number;
  /** Confirmed deleted/archived upstream — marked reconciled. */
  reconciled: number;
  /** Left pending for the next pass (network error, non-2xx/404 response, etc). */
  failed: number;
}

/**
 * Walk up to `limit` pending evicted sessions, oldest first, and call
 * `deleteUpstreamSession` for each. A row is marked reconciled ONLY on a
 * confirmed delete; anything else (thrown error, `false` return) leaves it
 * pending so the next sweep retries it — reconciliation only ever narrows the
 * orphan set, it never gives up and drops a row on the floor.
 *
 * `database` is an explicit optional override, defaulting to the module
 * singleton via the SAME test seam state-db.ts's own accessors use (a raw
 * `bun:sqlite` `Database`, never threaded through env) — it exists so this
 * function is unit-testable against a throwaway temp DB rather than the
 * env-bound singleton (unsafe to exercise across test files in-process, see
 * state-db.test.ts).
 */
export async function reconcileEvictedSessions(
  deleteUpstreamSession: (sessionId: string) => Promise<boolean>,
  limit = 100,
  database?: Database,
): Promise<ReconcileResult> {
  const pending = database ? listPendingEvictedSessions(limit, database) : listPendingEvictedSessions(limit);
  let reconciled = 0;
  let failed = 0;

  for (const row of pending) {
    let ok: boolean;
    try {
      ok = await deleteUpstreamSession(row.sessionId);
    } catch (err) {
      ok = false;
      logger.warn('session_reconcile_error', { sessionId: row.sessionId, error: String(err) });
    }
    if (ok) {
      if (database) markSessionReconciled(row.sessionId, database);
      else markSessionReconciled(row.sessionId);
      reconciled += 1;
    } else {
      failed += 1;
    }
  }

  if (pending.length > 0) {
    logger.info('session_reconcile_sweep', { attempted: pending.length, reconciled, failed });
  }
  return { attempted: pending.length, reconciled, failed };
}

/**
 * Real upstream delete: `DELETE /session/{id}` straight to the assistant,
 * bypassing the `/oc` proxy entirely — by the time a session is evicted its
 * ownership row is already gone, so the proxy's `ownsSession` check would
 * 403 it (correctly, for a normal caller; wrongly, for this sweep, which acts
 * with the guardian's own authority, not a principal's). A 404 means the
 * session is already gone upstream — treat that as success too, so the log
 * entry still clears rather than retrying forever.
 */
export async function deleteUpstreamSessionViaAssistant(sessionId: string): Promise<boolean> {
  const response = await fetch(`${ASSISTANT_URL}/session/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: withAssistantUpstreamAuth(new Headers()),
  });
  return response.ok || response.status === 404;
}
