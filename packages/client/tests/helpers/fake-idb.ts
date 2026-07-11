/**
 * F11 [connections/index.ts openDatabase] — a minimal, hand-rolled fake
 * IDBFactory, in the same spirit as the ad hoc fakes already used by
 * boot.test.ts/host-link.test.ts (this package has no real fake-indexeddb
 * dependency — see the `devDependencies` note in package.json's "NEVER
 * depends on" rule for why nothing new was added). It implements just
 * enough of the real IndexedDB surface for src/lib/connections/index.ts's
 * `createIndexedDbStorage()` to exercise:
 *
 *   - a normal open() -> onupgradeneeded (first time) -> onsuccess flow,
 *     backed by real in-memory Maps per object store so getAll/get/put/
 *     delete behave like the real thing across "reopens",
 *   - a permanently-blocked open() that only ever fires onblocked (never
 *     onupgradeneeded/onsuccess) — simulating another tab holding a
 *     pre-upgrade connection open forever,
 *   - counting how many times indexedDB.open() was actually called, and
 *     exposing the last-opened fake "db" object so a test can fire a
 *     versionchange event on it from outside (simulating another tab
 *     requesting a further upgrade).
 */

type Listener<E> = ((ev: E) => void) | null;

class FakeRequest<T> {
  onsuccess: Listener<Event> = null;
  onerror: Listener<Event> = null;
  result: T | undefined;
  error: Error | null = null;
}

function resolveRequest<T>(request: FakeRequest<T>, result: T): void {
  queueMicrotask(() => {
    request.result = result;
    request.onsuccess?.(new Event('success'));
  });
}

class FakeObjectStoreHandle {
  constructor(private readonly map: Map<string, unknown>, private readonly keyPath?: string) {}

  getAll(): FakeRequest<unknown[]> {
    const request = new FakeRequest<unknown[]>();
    resolveRequest(request, [...this.map.values()]);
    return request;
  }

  get(key: string): FakeRequest<unknown> {
    const request = new FakeRequest<unknown>();
    resolveRequest(request, this.map.get(key));
    return request;
  }

  put(value: unknown, key?: string): FakeRequest<void> {
    const resolvedKey = key ?? (this.keyPath ? (value as Record<string, string>)[this.keyPath] : undefined);
    if (resolvedKey === undefined) throw new Error('fake-idb: put() needs a key or a keyPath value');
    this.map.set(resolvedKey, value);
    const request = new FakeRequest<void>();
    resolveRequest(request, undefined);
    return request;
  }

  delete(key: string): FakeRequest<void> {
    this.map.delete(key);
    const request = new FakeRequest<void>();
    resolveRequest(request, undefined);
    return request;
  }
}

export type FakeIdbDatabase = {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options?: { keyPath?: string }): void;
  transaction(name: string): { objectStore(name: string): FakeObjectStoreHandle };
  close(): void;
  onversionchange: Listener<Event>;
  closed: boolean;
};

export type FakeIndexedDbHarness = {
  factory: IDBFactory;
  getOpenCalls(): number;
  getCurrentDb(): FakeIdbDatabase | null;
  setBlockForever(block: boolean): void;
};

/** Creates a fresh fake IndexedDB backend (own set of stores) per call. */
export function createFakeIndexedDbHarness(): FakeIndexedDbHarness {
  let openCalls = 0;
  let blockForever = false;
  let currentDb: FakeIdbDatabase | null = null;
  const storeDefs = new Map<string, { keyPath?: string }>();
  const stores = new Map<string, Map<string, unknown>>();

  function makeDb(): FakeIdbDatabase {
    const db: FakeIdbDatabase = {
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore(name: string, options?: { keyPath?: string }) {
        stores.set(name, new Map());
        storeDefs.set(name, { keyPath: options?.keyPath });
      },
      transaction(name: string) {
        const map = stores.get(name);
        if (!map) throw new Error(`fake-idb: no such store ${name}`);
        const def = storeDefs.get(name);
        return { objectStore: () => new FakeObjectStoreHandle(map, def?.keyPath) };
      },
      close() {
        db.closed = true;
        if (currentDb === db) currentDb = null;
      },
      onversionchange: null,
      closed: false,
    };
    return db;
  }

  const factory: Partial<IDBFactory> = {
    open(_name: string, _version?: number) {
      openCalls += 1;
      const request = new FakeRequest<FakeIdbDatabase>() as unknown as IDBOpenDBRequest & {
        onblocked: Listener<Event>;
        onupgradeneeded: Listener<Event>;
      };
      request.onblocked = null;
      request.onupgradeneeded = null;
      queueMicrotask(() => {
        if (blockForever) {
          request.onblocked?.(new Event('blocked'));
          return; // Permanently blocked: onupgradeneeded/onsuccess never fire.
        }
        const isFirstOpen = stores.size === 0;
        const db = makeDb();
        currentDb = db;
        (request as unknown as FakeRequest<FakeIdbDatabase>).result = db;
        if (isFirstOpen) request.onupgradeneeded?.(new Event('upgradeneeded'));
        request.onsuccess?.(new Event('success'));
      });
      return request;
    },
    cmp() {
      return 0;
    },
    deleteDatabase() {
      throw new Error('fake-idb: deleteDatabase not implemented');
    },
    databases: async () => [],
  };

  return {
    factory: factory as IDBFactory,
    getOpenCalls: () => openCalls,
    getCurrentDb: () => currentDb,
    setBlockForever: (block: boolean) => {
      blockForever = block;
    },
  };
}
