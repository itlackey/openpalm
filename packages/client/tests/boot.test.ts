import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

type MutableGlobals = typeof globalThis & {
  fetch?: typeof globalThis.fetch;
  indexedDB?: IDBFactory;
};

function seededConfigResponse(): Response {
  return Response.json({
    connections: [
      {
        id: 'seed-local-opencode',
        label: 'This assistant',
        kind: 'local-opencode',
        url: 'http://127.0.0.1:4096',
        auth: { mode: 'none' },
        isDefault: true,
        locked: true,
      },
    ],
  });
}

function createRejectingIndexedDbFactory(): IDBFactory {
  return {
    open() {
      const request: Partial<IDBOpenDBRequest> & { error: Error | null } = {
        error: null,
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        request.error = new Error('IndexedDB open failed');
        request.onerror?.call(request as IDBOpenDBRequest, new Event('error'));
      });
      return request as IDBOpenDBRequest;
    },
    cmp() {
      return 0;
    },
    deleteDatabase() {
      throw new Error('not implemented');
    },
    databases: async () => [],
  } as IDBFactory;
}

describe('getClientBoot', () => {
  const originalFetch = globalThis.fetch;
  const originalIndexedDb = globalThis.indexedDB;

  beforeEach(() => {
    (globalThis as MutableGlobals).fetch = async () => seededConfigResponse();
    (globalThis as MutableGlobals).indexedDB = createRejectingIndexedDbFactory();
  });

  afterEach(() => {
    const globals = globalThis as MutableGlobals;
    if (originalFetch === undefined) delete globals.fetch;
    else globals.fetch = originalFetch;
    if (originalIndexedDb === undefined) delete globals.indexedDB;
    else globals.indexedDB = originalIndexedDb;
  });

  test('falls back to memory storage when IndexedDB open rejects, and a later call still resolves', async () => {
    const { getClientBoot } = await import('../src/lib/boot.ts');

    const first = await getClientBoot();
    expect(await first.store.list()).toEqual([
      {
        id: 'seed-local-opencode',
        label: 'This assistant',
        kind: 'local-opencode',
        url: 'http://127.0.0.1:4096',
        auth: { mode: 'none' },
        isDefault: true,
        locked: true,
      },
    ]);
    expect(await first.store.getActiveId()).toBe('seed-local-opencode');

    const second = await getClientBoot();
    expect(await second.store.list()).toEqual(await first.store.list());
    expect(await second.store.getActiveId()).toBe('seed-local-opencode');
  });
});
