/**
 * reconcileEvictedSessions / drainEvictedSessions / verifyThenDeleteUpstreamSession
 * unit tests (S4, #581 finding #7; lifecycle-aware eviction redesign, #586).
 *
 * Drives a raw `bun:sqlite` `Database` opened on a `mkdtempSync` temp path —
 * same seam state-db.test.ts uses — with a fake `deleteUpstreamSession`, so
 * this never touches the env-bound state-db singleton or a real assistant.
 *
 * #586 changed the injected callback's return type from `Promise<boolean>` to
 * `Promise<UpstreamSessionOutcome>` ('deleted' | 'active' | 'failed') so a
 * confirmed-active session (Defect A) can be distinguished from a genuine
 * failure (network/assistant down): an 'active' outcome restores (un-evicts)
 * the ownership row and reports under the new `deferred` ReconcileResult
 * category, which — unlike `failed` — must never stop drainEvictedSessions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configureStateDatabase, recordSessionOwnerRow, listPendingEvictedSessions } from './state-db.ts';
import {
  reconcileEvictedSessions,
  drainEvictedSessions,
  verifyThenDeleteUpstreamSession,
  type UpstreamSessionOutcome,
} from './reconciliation.ts';

describe('reconcileEvictedSessions', () => {
  let tmpDir: string;
  let database: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-reconcile-test-'));
    database = new Database(join(tmpDir, 'state.db'), { create: true });
    configureStateDatabase(database);
  });

  afterEach(() => {
    database.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function evictSessions(count: number): void {
    // maxRows=0 evicts every inserted row immediately, one at a time.
    for (let i = 0; i < count; i++) {
      recordSessionOwnerRow(`ses_${i}`, 'p1', i, database, /* maxRows */ 0);
    }
  }

  it('marks every pending session reconciled when the delete callback always succeeds', async () => {
    evictSessions(3);
    const seen: string[] = [];
    const result = await reconcileEvictedSessions(
      async (sessionId): Promise<UpstreamSessionOutcome> => {
        seen.push(sessionId);
        return 'deleted';
      },
      100,
      database,
    );

    expect(result).toEqual({ attempted: 3, reconciled: 3, deferred: 0, failed: 0 });
    expect(seen).toEqual(['ses_0', 'ses_1', 'ses_2']);
    expect(listPendingEvictedSessions(100, database)).toEqual([]);
  });

  it('leaves a session pending when the delete callback returns failed', async () => {
    evictSessions(2);
    const result = await reconcileEvictedSessions(
      async (sessionId): Promise<UpstreamSessionOutcome> => (sessionId !== 'ses_0' ? 'deleted' : 'failed'),
      100,
      database,
    );

    expect(result).toEqual({ attempted: 2, reconciled: 1, deferred: 0, failed: 1 });
    const pending = listPendingEvictedSessions(100, database).map((r) => r.sessionId);
    expect(pending).toEqual(['ses_0']);
  });

  it('leaves a session pending (never drops it) when the delete callback throws', async () => {
    evictSessions(1);
    const result = await reconcileEvictedSessions(async () => {
      throw new Error('network error');
    }, 100, database);

    expect(result).toEqual({ attempted: 1, reconciled: 0, deferred: 0, failed: 1 });
    expect(listPendingEvictedSessions(100, database)).toHaveLength(1);
  });

  it('is a no-op when there is nothing pending', async () => {
    let calls = 0;
    const result = await reconcileEvictedSessions(async (): Promise<UpstreamSessionOutcome> => {
      calls += 1;
      return 'deleted';
    }, 100, database);

    expect(result).toEqual({ attempted: 0, reconciled: 0, deferred: 0, failed: 0 });
    expect(calls).toBe(0);
  });

  it('respects the limit, leaving the rest pending for the next sweep', async () => {
    evictSessions(5);
    const seen: string[] = [];
    const result = await reconcileEvictedSessions(
      async (sessionId): Promise<UpstreamSessionOutcome> => {
        seen.push(sessionId);
        return 'deleted';
      },
      2,
      database,
    );

    expect(result).toEqual({ attempted: 2, reconciled: 2, deferred: 0, failed: 0 });
    expect(seen).toEqual(['ses_0', 'ses_1']);
    const pending = listPendingEvictedSessions(100, database).map((r) => r.sessionId);
    expect(pending).toEqual(['ses_2', 'ses_3', 'ses_4']);
  });

  it('a session already reconciled is never revisited by a later sweep', async () => {
    evictSessions(2);
    await reconcileEvictedSessions(async (): Promise<UpstreamSessionOutcome> => 'deleted', 100, database);
    // Second sweep: nothing pending, callback must not be called again.
    let calls = 0;
    const result = await reconcileEvictedSessions(
      async (): Promise<UpstreamSessionOutcome> => {
        calls += 1;
        return 'deleted';
      },
      100,
      database,
    );
    expect(result).toEqual({ attempted: 0, reconciled: 0, deferred: 0, failed: 0 });
    expect(calls).toBe(0);
  });

  it('restores (un-evicts) the ownership row on an "active" outcome and reports it as deferred, not failed (decision 586-1)', async () => {
    evictSessions(1); // ses_0 evicted, owned by 'p1'
    const result = await reconcileEvictedSessions(async (): Promise<UpstreamSessionOutcome> => 'active', 100, database);

    expect(result).toEqual({ attempted: 1, reconciled: 0, deferred: 1, failed: 0 });
    // Restored: the ownership row is back, under the same principal.
    const owner = database.query('SELECT principal_key FROM session_owners WHERE session_id = ?').get('ses_0');
    expect(owner).toEqual({ principal_key: 'p1' });
    // The eviction incident is resolved (not left pending for a retry) —
    // restoration is a terminal resolution, distinct from deletion.
    expect(listPendingEvictedSessions(100, database)).toEqual([]);
  });

  it('an "active" outcome mixed with "deleted" and "failed" in the same pass reports each under its own category', async () => {
    evictSessions(3);
    const outcomeFor: Record<string, UpstreamSessionOutcome> = {
      ses_0: 'deleted',
      ses_1: 'active',
      ses_2: 'failed',
    };
    const result = await reconcileEvictedSessions(async (sessionId) => outcomeFor[sessionId] ?? 'failed', 100, database);

    expect(result).toEqual({ attempted: 3, reconciled: 1, deferred: 1, failed: 1 });
    const pending = listPendingEvictedSessions(100, database).map((r) => r.sessionId);
    expect(pending).toEqual(['ses_2']); // only the genuinely-failed row stays pending
  });
});

describe('drainEvictedSessions (Fix B, #586)', () => {
  let tmpDir: string;
  let database: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-drain-test-'));
    database = new Database(join(tmpDir, 'state.db'), { create: true });
    configureStateDatabase(database);
  });

  afterEach(() => {
    database.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function evictSessions(count: number, evictionLogMaxRows = 10_000): void {
    for (let i = 0; i < count; i++) {
      recordSessionOwnerRow(`ses_${i}`, 'p1', i, database, /* maxRows */ 0, evictionLogMaxRows);
    }
  }

  it('AC2 backlog: 250 evictions over a 50-row eviction-log cap, always-failing callback drops NOTHING; recovery reconciles all 250 in one drainEvictedSessions call', async () => {
    // Eviction-log cap (50) is deliberately far below the 250 evicted rows —
    // Fix B's prune only ever removes RECONCILED rows, so a persistently
    // failing assistant (nothing reconciles yet) must never lose one.
    evictSessions(250, /* evictionLogMaxRows */ 50);
    expect(listPendingEvictedSessions(10_000, database)).toHaveLength(250);

    const failedResult = await drainEvictedSessions(async (): Promise<UpstreamSessionOutcome> => 'failed', 50, database);
    expect(failedResult).toEqual({ attempted: 50, reconciled: 0, deferred: 0, failed: 50 });
    // Stopped after the first failing batch — but critically, ALL 250 rows
    // are still pending: none were silently dropped by the eviction-log cap.
    expect(listPendingEvictedSessions(10_000, database)).toHaveLength(250);

    // Recovery: the assistant is back. One drainEvictedSessions call
    // reconciles the entire 250-row backlog, looping across 5 batches of 50.
    const recovered = await drainEvictedSessions(async (): Promise<UpstreamSessionOutcome> => 'deleted', 50, database);
    expect(recovered).toEqual({ attempted: 250, reconciled: 250, deferred: 0, failed: 0 });
    expect(listPendingEvictedSessions(10_000, database)).toEqual([]);
  });

  it('loops across multiple batches to fully reconcile a large backlog in one call (AC2 backlog recovery)', async () => {
    evictSessions(250);
    expect(listPendingEvictedSessions(10_000, database)).toHaveLength(250);

    const result = await drainEvictedSessions(async (): Promise<UpstreamSessionOutcome> => 'deleted', 50, database);

    expect(result).toEqual({ attempted: 250, reconciled: 250, deferred: 0, failed: 0 });
    expect(listPendingEvictedSessions(10_000, database)).toEqual([]);
  });

  it('a failure mid-drain stops the loop; rows behind the failure are never attempted (AC2 backlog, zero pending dropped)', async () => {
    evictSessions(150);

    const result = await drainEvictedSessions(
      async (sessionId): Promise<UpstreamSessionOutcome> => (Number(sessionId.slice(4)) < 50 ? 'deleted' : 'failed'),
      50,
      database,
    );

    // First batch (ses_0..49) reconciles cleanly; second batch (ses_50..99)
    // all fail, which stops the drain — the third batch (ses_100..149) is
    // never even attempted.
    expect(result).toEqual({ attempted: 100, reconciled: 50, deferred: 0, failed: 50 });
    const stillPending = listPendingEvictedSessions(10_000, database).map((r) => r.sessionId);
    expect(stillPending).toHaveLength(100);
    expect(stillPending).not.toContain('ses_0');
    expect(stillPending).toContain('ses_50');
    expect(stillPending).toContain('ses_149');
  });

  it('deferred (active-session) results do NOT stop the drain loop', async () => {
    evictSessions(100);

    // First batch (ses_0..49) all defer as active (restored, not failed);
    // second batch (ses_50..99) all delete cleanly. The loop must run BOTH
    // batches — a failure would have stopped it, a deferral must not.
    const result = await drainEvictedSessions(
      async (sessionId): Promise<UpstreamSessionOutcome> => (Number(sessionId.slice(4)) < 50 ? 'active' : 'deleted'),
      50,
      database,
    );

    expect(result).toEqual({ attempted: 100, reconciled: 50, deferred: 50, failed: 0 });
    expect(listPendingEvictedSessions(10_000, database)).toEqual([]);
  });

  it('documents accepted behavior: a persistently-failing oldest row starves newer, healthy rows behind it (head-of-line note, #586)', async () => {
    // Explicit, distinct `now` values (rather than the real wall clock) so
    // evicted_at ordering is deterministic even though both inserts happen in
    // the same test tick — a same-millisecond tie would fall back to
    // session_id ASC and silently invert the intended ordering.
    recordSessionOwnerRow('ses_stuck', 'p1', 0, database, /* maxRows */ 0, /* evictionLogMaxRows */ 10_000, /* activeGraceMs */ 0, /* now */ 100);
    recordSessionOwnerRow('ses_healthy', 'p1', 1, database, 0, 10_000, 0, 200);

    const attempts: string[] = [];
    const callback = async (sessionId: string): Promise<UpstreamSessionOutcome> => {
      attempts.push(sessionId);
      return sessionId === 'ses_stuck' ? 'failed' : 'deleted';
    };

    // listPendingEvictedSessions orders oldest evicted_at first — ses_stuck
    // (evicted first) is always selected ahead of ses_healthy. With batch=1,
    // every sweep re-selects the SAME persistently-failing row, and
    // drainEvictedSessions stops on the first failure — so ses_healthy is
    // never even attempted despite being perfectly reconcilable. This is
    // accepted behavior (head-of-line rotation was descoped; see the plan)
    // rather than a rotation fix.
    const result = await drainEvictedSessions(callback, /* batch */ 1, database);

    expect(attempts).toEqual(['ses_stuck']);
    expect(result).toEqual({ attempted: 1, reconciled: 0, deferred: 0, failed: 1 });
    const stillPending = listPendingEvictedSessions(100, database).map((r) => r.sessionId);
    expect(stillPending).toEqual(['ses_stuck', 'ses_healthy']);
  });
});

describe('verifyThenDeleteUpstreamSession (Fix A step 4, #586)', () => {
  let stub: ReturnType<typeof Bun.serve>;
  let deleteCalls: string[];
  let getResponder: (sessionId: string) => Response;

  beforeEach(() => {
    deleteCalls = [];
    getResponder = () => new Response('not found', { status: 404 });
    stub = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const match = /^\/session\/([^/]+)$/.exec(url.pathname);
        if (!match) return new Response('not found', { status: 404 });
        const sessionId = match[1];
        if (req.method === 'DELETE') {
          deleteCalls.push(sessionId);
          return new Response(null, { status: 200 });
        }
        if (req.method === 'GET') return getResponder(sessionId);
        return new Response('method not allowed', { status: 405 });
      },
    });
  });

  afterEach(() => {
    stub.stop(true);
  });

  function baseUrl(): string {
    return `http://127.0.0.1:${stub.port}`;
  }

  it('recent time.updated ⇒ active, no DELETE issued', async () => {
    const now = Date.now();
    getResponder = () => Response.json({ id: 'ses_active', time: { created: now - 10_000, updated: now - 1_000 } });
    const outcome = await verifyThenDeleteUpstreamSession(baseUrl(), 'ses_active', /* activeGraceMs */ 60_000);
    expect(outcome).toBe('active');
    expect(deleteCalls).toEqual([]);
  });

  it('stale time.updated ⇒ deleted, DELETE issued', async () => {
    const now = Date.now();
    getResponder = () => Response.json({ id: 'ses_stale', time: { created: now - 100_000, updated: now - 90_000 } });
    const outcome = await verifyThenDeleteUpstreamSession(baseUrl(), 'ses_stale', /* activeGraceMs */ 1_000);
    expect(outcome).toBe('deleted');
    expect(deleteCalls).toEqual(['ses_stale']);
  });

  it('404 on the initial GET ⇒ deleted (already gone upstream), no DELETE issued', async () => {
    getResponder = () => new Response('not found', { status: 404 });
    const outcome = await verifyThenDeleteUpstreamSession(baseUrl(), 'ses_gone', 60_000);
    expect(outcome).toBe('deleted');
    expect(deleteCalls).toEqual([]);
  });

  it('500 on the initial GET ⇒ failed (fail-safe defer), no DELETE issued', async () => {
    getResponder = () => new Response('boom', { status: 500 });
    const outcome = await verifyThenDeleteUpstreamSession(baseUrl(), 'ses_error', 60_000);
    expect(outcome).toBe('failed');
    expect(deleteCalls).toEqual([]);
  });

  it('unparsable GET body ⇒ failed (fail-safe defer), no DELETE issued', async () => {
    getResponder = () => new Response('not json{{{', { status: 200, headers: { 'content-type': 'application/json' } });
    const outcome = await verifyThenDeleteUpstreamSession(baseUrl(), 'ses_badbody', 60_000);
    expect(outcome).toBe('failed');
    expect(deleteCalls).toEqual([]);
  });

  it('a network error reaching the assistant ⇒ failed (fail-safe defer)', async () => {
    // Point at a closed port (stub not listening there) to force a connection error.
    const outcome = await verifyThenDeleteUpstreamSession('http://127.0.0.1:1', 'ses_unreachable', 60_000);
    expect(outcome).toBe('failed');
  });

  it('a failed DELETE after a confirmed-stale GET is reported as failed, not deleted', async () => {
    const now = Date.now();
    getResponder = () => Response.json({ id: 'ses_stale2', time: { created: now - 100_000, updated: now - 90_000 } });
    const fetchLike: typeof fetch = async (input, init) => {
      if (init?.method === 'DELETE') return new Response('boom', { status: 500 });
      return fetch(input as string, init);
    };
    const outcome = await verifyThenDeleteUpstreamSession(baseUrl(), 'ses_stale2', 1_000, fetchLike);
    expect(outcome).toBe('failed');
  });
});
