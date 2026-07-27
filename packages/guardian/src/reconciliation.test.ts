/**
 * reconcileEvictedSessions unit tests (S4, #581 finding #7).
 *
 * Drives a raw `bun:sqlite` `Database` opened on a `mkdtempSync` temp path —
 * same seam state-db.test.ts uses — with a fake `deleteUpstreamSession`, so
 * this never touches the env-bound state-db singleton or a real assistant.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configureStateDatabase, recordSessionOwnerRow, listPendingEvictedSessions } from './state-db.ts';
import { reconcileEvictedSessions } from './reconciliation.ts';

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
      async (sessionId) => {
        seen.push(sessionId);
        return true;
      },
      100,
      database,
    );

    expect(result).toEqual({ attempted: 3, reconciled: 3, failed: 0 });
    expect(seen).toEqual(['ses_0', 'ses_1', 'ses_2']);
    expect(listPendingEvictedSessions(100, database)).toEqual([]);
  });

  it('leaves a session pending when the delete callback returns false', async () => {
    evictSessions(2);
    const result = await reconcileEvictedSessions(async (sessionId) => sessionId !== 'ses_0', 100, database);

    expect(result).toEqual({ attempted: 2, reconciled: 1, failed: 1 });
    const pending = listPendingEvictedSessions(100, database).map((r) => r.sessionId);
    expect(pending).toEqual(['ses_0']);
  });

  it('leaves a session pending (never drops it) when the delete callback throws', async () => {
    evictSessions(1);
    const result = await reconcileEvictedSessions(async () => {
      throw new Error('network error');
    }, 100, database);

    expect(result).toEqual({ attempted: 1, reconciled: 0, failed: 1 });
    expect(listPendingEvictedSessions(100, database)).toHaveLength(1);
  });

  it('is a no-op when there is nothing pending', async () => {
    let calls = 0;
    const result = await reconcileEvictedSessions(async () => {
      calls += 1;
      return true;
    }, 100, database);

    expect(result).toEqual({ attempted: 0, reconciled: 0, failed: 0 });
    expect(calls).toBe(0);
  });

  it('respects the limit, leaving the rest pending for the next sweep', async () => {
    evictSessions(5);
    const seen: string[] = [];
    const result = await reconcileEvictedSessions(
      async (sessionId) => {
        seen.push(sessionId);
        return true;
      },
      2,
      database,
    );

    expect(result).toEqual({ attempted: 2, reconciled: 2, failed: 0 });
    expect(seen).toEqual(['ses_0', 'ses_1']);
    const pending = listPendingEvictedSessions(100, database).map((r) => r.sessionId);
    expect(pending).toEqual(['ses_2', 'ses_3', 'ses_4']);
  });

  it('a session already reconciled is never revisited by a later sweep', async () => {
    evictSessions(2);
    await reconcileEvictedSessions(async () => true, 100, database);
    // Second sweep: nothing pending, callback must not be called again.
    let calls = 0;
    const result = await reconcileEvictedSessions(
      async () => {
        calls += 1;
        return true;
      },
      100,
      database,
    );
    expect(result).toEqual({ attempted: 0, reconciled: 0, failed: 0 });
    expect(calls).toBe(0);
  });
});
