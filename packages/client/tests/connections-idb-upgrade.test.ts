/**
 * F11 [connections/index.ts openDatabase ~205] — IDB_VERSION was bumped
 * 1 -> 2 for E7 (the AES-GCM key store) with NO `request.onblocked` handler
 * and NO `versionchange` listener on an already-open connection. A v1
 * connection held open in another tab blocks the v2 upgrade transaction
 * from ever starting: indexedDB.open()'s request never fires onsuccess OR
 * onerror in that case (only onblocked, which openDatabase() previously
 * ignored entirely) — the returned Promise never settles, so
 * getClientBoot() hangs forever with no error surfaced anywhere.
 *
 * Fix pinned here: openDatabase() now rejects on `onblocked` with a clear
 * error (surfacing/handling instead of hanging), and a successfully-opened
 * connection installs an `onversionchange` handler that closes itself and
 * invalidates the cached db promise — so a THIS tab's own held-open
 * connection doesn't itself block some future upgrade (e.g. this tab is
 * open when another tab needs to bump IDB_VERSION again later).
 *
 * RED until src/lib/connections/index.ts's openDatabase() handles
 * onblocked and installs onversionchange: the "rejects instead of hanging"
 * assertion times out (no onblocked handler = the promise never settles),
 * and the "reopens after versionchange" assertion fails because nothing
 * ever sets db.onversionchange, so triggering it does nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createFakeIndexedDbHarness } from './helpers/fake-idb.ts';

type MutableGlobals = typeof globalThis & { indexedDB?: IDBFactory };

describe('createIndexedDbStorage — blocked upgrade (F11)', () => {
  const originalIndexedDb = globalThis.indexedDB;

  afterEach(() => {
    const globals = globalThis as MutableGlobals;
    if (originalIndexedDb === undefined) delete globals.indexedDB;
    else globals.indexedDB = originalIndexedDb;
  });

  test(
    'a permanently-blocked upgrade rejects instead of hanging forever',
    async () => {
      const harness = createFakeIndexedDbHarness();
      harness.setBlockForever(true);
      (globalThis as MutableGlobals).indexedDB = harness.factory;

      const { createIndexedDbStorage } = await import('../src/lib/connections/index.ts');
      const storage = createIndexedDbStorage();

      await expect(storage.getAll()).rejects.toThrow();
    },
    2000
  );

  test('a versionchange event on an open connection closes it and invalidates the cache so the next call reopens', async () => {
    const harness = createFakeIndexedDbHarness();
    (globalThis as MutableGlobals).indexedDB = harness.factory;

    const { createIndexedDbStorage } = await import('../src/lib/connections/index.ts');
    const storage = createIndexedDbStorage();

    await storage.getAll();
    expect(harness.getOpenCalls()).toBe(1);

    // Simulate another tab requesting a further upgrade: it fires
    // `versionchange` on every already-open connection so they can close
    // and get out of the way.
    const db = harness.getCurrentDb();
    expect(db).not.toBeNull();
    db?.onversionchange?.(new Event('versionchange'));
    expect(db?.closed).toBe(true);

    await storage.getAll();
    expect(harness.getOpenCalls()).toBe(2);
  });

  test('a normal (unblocked) open still resolves and getAll() works end to end', async () => {
    const harness = createFakeIndexedDbHarness();
    (globalThis as MutableGlobals).indexedDB = harness.factory;

    const { createIndexedDbStorage } = await import('../src/lib/connections/index.ts');
    const storage = createIndexedDbStorage();

    expect(await storage.getAll()).toEqual([]);
    await storage.put({
      id: 'conn-1',
      label: 'Test',
      kind: 'remote-opencode',
      url: 'http://x',
      auth: { mode: 'none' },
    });
    expect(await storage.getAll()).toHaveLength(1);
  });
});
