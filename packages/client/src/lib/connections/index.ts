/**
 * Client-side connection store (plan ui-runtime-modes-plan.md §6.6; P5b
 * item 2, #555).
 *
 * ConnectionEntry records persist behind a storage abstraction so the same
 * store logic runs over IndexedDB in the browser (offline-readable, plan
 * §6.10) and over an in-memory backend in tests. The store API is async
 * throughout (IndexedDB is async) and keeps NO state in store-instance
 * fields — a page reload constructs a new store over the same backend and
 * must see identical state. packages/client/tests/connections-*.test.ts is
 * the pinned contract for both backends.
 *
 * Locked/default entries are seeded from a runtime-config.json fetched from
 * the app's own origin at boot (the assistant container writes the file
 * beside the static build, P5d). Absent file = no default connection.
 */

export type ConnectionKind = 'local-opencode' | 'remote-opencode' | 'openpalm-client-api';

/**
 * Plan §6.6 ConnectionEntry, client-side. `grantedCapabilities` is a plain
 * string list here — the client's type space has no host:* capabilities
 * (plan §4.3 note, §8.5: host features are absent from the artifact), and
 * grants must be server-verified at connection-add time (§8.9).
 */
export type ConnectionEntry = {
  id: string;
  label: string;
  kind: ConnectionKind;
  url: string;
  /** Credentials live under `secretRef` in the secret store — never inline. */
  auth: { mode: 'none' | 'basic' | 'bearer'; secretRef?: string };
  isDefault?: boolean;
  locked?: boolean;
  grantedCapabilities?: string[];
};

export type NewConnectionInput = Omit<ConnectionEntry, 'id'> & { id?: string };

/** Shape of the runtime-config.json written beside the static build (P5d). */
export type RuntimeConfig = {
  connections: ConnectionEntry[];
};

/**
 * Storage backend contract: connection records by id plus a small string
 * meta area (active selection, secret material). Implemented by
 * createMemoryStorage() (tests) and createIndexedDbStorage() (browser) —
 * the ConnectionStore is the only consumer.
 */
export type ConnectionStorage = {
  getAll(): Promise<ConnectionEntry[]>;
  get(id: string): Promise<ConnectionEntry | null>;
  put(entry: ConnectionEntry): Promise<void>;
  delete(id: string): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  /** null deletes the key. */
  setMeta(key: string, value: string | null): Promise<void>;
};

export type ConnectionStore = {
  list(): Promise<ConnectionEntry[]>;
  get(id: string): Promise<ConnectionEntry | null>;
  /** Generates an id when the input has none. */
  add(input: NewConnectionInput): Promise<ConnectionEntry>;
  /** Rejects for unknown ids and for locked entries. */
  update(id: string, patch: Partial<Omit<ConnectionEntry, 'id'>>): Promise<ConnectionEntry>;
  /** Rejects for unknown ids and for locked entries. */
  remove(id: string): Promise<void>;
  getActiveId(): Promise<string | null>;
  getActive(): Promise<ConnectionEntry | null>;
  /** Rejects for unknown ids. */
  setActive(id: string): Promise<void>;
  /**
   * Upsert the config's (locked/default) entries by id. null config = no-op.
   * A seeded isDefault entry becomes active when nothing is active yet, but
   * never steals an explicit user selection. Config wins for locked entries
   * (label/url updates apply on re-seed); user-added entries are untouched.
   */
  seedFromRuntimeConfig(config: RuntimeConfig | null): Promise<void>;
};

const ACTIVE_ID_KEY = 'activeId';

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** In-memory storage backend — same semantics as the IndexedDB one. */
export function createMemoryStorage(): ConnectionStorage {
  const entries = new Map<string, ConnectionEntry>();
  const meta = new Map<string, string>();
  return {
    async getAll() {
      return [...entries.values()].map(clone);
    },
    async get(id) {
      const entry = entries.get(id);
      return entry ? clone(entry) : null;
    },
    async put(entry) {
      entries.set(entry.id, clone(entry));
    },
    async delete(id) {
      entries.delete(id);
    },
    async getMeta(key) {
      return meta.get(key) ?? null;
    },
    async setMeta(key, value) {
      if (value === null) meta.delete(key);
      else meta.set(key, value);
    },
  };
}

// ── IndexedDB backend (browser) ──────────────────────────────────────────

const IDB_NAME = 'openpalm-client';
const IDB_VERSION = 1;
const STORE_CONNECTIONS = 'connections';
const STORE_META = 'meta';

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_CONNECTIONS)) {
        db.createObjectStore(STORE_CONNECTIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

/**
 * IndexedDB storage backend (raw IDB API, no deps). Lazily opens the
 * database on first use; each operation runs in its own short transaction.
 */
export function createIndexedDbStorage(): ConnectionStorage {
  let db: Promise<IDBDatabase> | null = null;
  const database = (): Promise<IDBDatabase> => {
    db ??= openDatabase();
    return db;
  };
  const store = async (name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> =>
    (await database()).transaction(name, mode).objectStore(name);

  return {
    async getAll() {
      return idbRequest<ConnectionEntry[]>(
        (await store(STORE_CONNECTIONS, 'readonly')).getAll() as IDBRequest<ConnectionEntry[]>
      );
    },
    async get(id) {
      const found = await idbRequest<ConnectionEntry | undefined>(
        (await store(STORE_CONNECTIONS, 'readonly')).get(id) as IDBRequest<
          ConnectionEntry | undefined
        >
      );
      return found ?? null;
    },
    async put(entry) {
      await idbRequest((await store(STORE_CONNECTIONS, 'readwrite')).put(entry));
    },
    async delete(id) {
      await idbRequest((await store(STORE_CONNECTIONS, 'readwrite')).delete(id));
    },
    async getMeta(key) {
      const found = await idbRequest<string | undefined>(
        (await store(STORE_META, 'readonly')).get(key) as IDBRequest<string | undefined>
      );
      return found ?? null;
    },
    async setMeta(key, value) {
      const metaStore = await store(STORE_META, 'readwrite');
      if (value === null) await idbRequest(metaStore.delete(key));
      else await idbRequest(metaStore.put(value, key));
    },
  };
}

// ── Store ────────────────────────────────────────────────────────────────

export function createConnectionStore(options: { storage: unknown }): ConnectionStore {
  const storage = options.storage as ConnectionStorage;

  async function requireEntry(id: string): Promise<ConnectionEntry> {
    const entry = await storage.get(id);
    if (!entry) throw new Error(`Unknown connection: ${id}`);
    return entry;
  }

  const store: ConnectionStore = {
    list() {
      return storage.getAll();
    },

    get(id) {
      return storage.get(id);
    },

    async add(input) {
      const id = input.id ?? crypto.randomUUID();
      if (await storage.get(id)) throw new Error(`Connection already exists: ${id}`);
      const entry: ConnectionEntry = { ...input, id };
      await storage.put(entry);
      return clone(entry);
    },

    async update(id, patch) {
      const entry = await requireEntry(id);
      if (entry.locked) throw new Error(`Connection is locked (config-owned): ${id}`);
      const updated: ConnectionEntry = { ...entry, ...patch, id };
      await storage.put(updated);
      return clone(updated);
    },

    async remove(id) {
      const entry = await requireEntry(id);
      if (entry.locked) throw new Error(`Connection is locked (config-owned): ${id}`);
      await storage.delete(id);
      if ((await storage.getMeta(ACTIVE_ID_KEY)) === id) {
        await storage.setMeta(ACTIVE_ID_KEY, null);
      }
    },

    getActiveId() {
      return storage.getMeta(ACTIVE_ID_KEY);
    },

    async getActive() {
      const id = await storage.getMeta(ACTIVE_ID_KEY);
      return id === null ? null : storage.get(id);
    },

    async setActive(id) {
      await requireEntry(id);
      await storage.setMeta(ACTIVE_ID_KEY, id);
    },

    async seedFromRuntimeConfig(config) {
      if (!config) return;
      for (const entry of config.connections) {
        const existing = await storage.get(entry.id);
        // Config wins for the entries it owns (locked), including on
        // re-seed; a same-id entry the user somehow owns is left alone.
        if (!existing || existing.locked) await storage.put(clone(entry));
      }
      if ((await storage.getMeta(ACTIVE_ID_KEY)) !== null) return;
      const fallback = config.connections.find((entry) => entry.isDefault);
      if (fallback && (await storage.get(fallback.id))) {
        await storage.setMeta(ACTIVE_ID_KEY, fallback.id);
      }
    },
  };

  return store;
}

// ── Runtime config ───────────────────────────────────────────────────────

/**
 * Fetch '/runtime-config.json' from the app's OWN origin (relative URL — the
 * static server ships the file beside the build; the client holds no other
 * trusted origin at boot). Absent (404), unreachable (offline), or malformed
 * -> null; never throws, so an offline PWA boot still reaches the stored
 * connection list (plan §6.10).
 */
export async function loadRuntimeConfig(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<RuntimeConfig | null> {
  try {
    const response = await fetchImpl('/runtime-config.json', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as { connections?: unknown } | null;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.connections)) return null;
    return parsed as RuntimeConfig;
  } catch {
    return null;
  }
}
