/**
 * Browser-owned connection store (Phase 3a — "One UI, delete the split").
 *
 * Connection records persist behind a storage abstraction so the same store
 * logic runs over IndexedDB in the browser (offline-readable) and over an
 * in-memory backend in tests. The store API is async throughout (IndexedDB is
 * async) and keeps NO state in store-instance fields — a page reload
 * constructs a new store over the same backend and must see identical state.
 *
 * Locked/default entries are seeded from a runtime-config.json fetched from
 * the app's own origin at boot. Absent file = no default connection.
 *
 * The Connection shape is `{ id, label, baseUrl, auth }` with auth narrowed to
 * none | basic (Guardian is a transparent OpenCode proxy — Basic is the only
 * connection credential model).
 */

import { isLoopbackHost, redactUrlUserinfo } from './url-policy.js';

/**
 * Credential reference on a connection. The username is stored inline (so the
 * edit form can show it without decrypting anything); the password lives
 * encrypted in the secret store under `secretRef` — never inline.
 */
export type ConnectionAuth =
  | { mode: 'none' }
  | { mode: 'basic'; username: string; secretRef: string };

export type Connection = {
  id: string;
  label: string;
  baseUrl: string;
  auth: ConnectionAuth;
  isDefault?: boolean;
  locked?: boolean;
};

export type NewConnectionInput = Omit<Connection, 'id'> & { id?: string };

/** Shape of the runtime-config.json written beside the static build. */
export type RuntimeConfig = {
  connections: Connection[];
};

function rewriteLoopbackUrlForBrowserHost(rawUrl: string): string {
  const locationLike = globalThis.location;
  const redactedUrl = redactUrlUserinfo(rawUrl);
  if (!locationLike || isLoopbackHost(locationLike.hostname)) return redactedUrl;
  try {
    const url = new URL(redactedUrl);
    if (!isLoopbackHost(url.hostname)) return redactedUrl;
    url.hostname = locationLike.hostname;
    return url.toString();
  } catch {
    return redactedUrl;
  }
}

function redactEntryUrl(entry: Connection): Connection {
  const baseUrl = redactUrlUserinfo(entry.baseUrl);
  return baseUrl === entry.baseUrl ? entry : { ...entry, baseUrl };
}

function assertUrlHasNoUserinfo(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  if (url.username || url.password) {
    throw new Error('Credentials must use the Authentication fields, not the connection URL.');
  }
}

function adaptRuntimeConfigForBrowser(config: RuntimeConfig): RuntimeConfig {
  return {
    connections: config.connections.map((entry) => ({
      ...redactEntryUrl(entry),
      baseUrl: entry.locked
        ? rewriteLoopbackUrlForBrowserHost(entry.baseUrl)
        : redactUrlUserinfo(entry.baseUrl),
    })),
  };
}

/**
 * Storage backend contract: connection records by id plus a small string meta
 * area (active selection, secret material). Implemented by
 * createMemoryStorage() (tests) and createIndexedDbStorage() (browser) — the
 * ConnectionStore and the secret store are the only consumers.
 */
export type ConnectionStorage = {
  getAll(): Promise<Connection[]>;
  get(id: string): Promise<Connection | null>;
  put(entry: Connection): Promise<void>;
  delete(id: string): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  /** null deletes the key. */
  setMeta(key: string, value: string | null): Promise<void>;
  /**
   * Structured-clone value area for the secret store's non-extractable
   * AES-GCM wrapping key. `getMeta`/`setMeta` round-trip JSON strings and
   * cannot carry an actual CryptoKey object — IndexedDB's structured-clone
   * algorithm can, so this is a distinct area rather than an overload. Returns
   * null until a key has been generated.
   */
  getCryptoKey(): Promise<CryptoKey | null>;
  setCryptoKey(key: CryptoKey): Promise<void>;
};

export type ConnectionStore = {
  list(): Promise<Connection[]>;
  get(id: string): Promise<Connection | null>;
  /** Generates an id when the input has none. */
  add(input: NewConnectionInput): Promise<Connection>;
  /** Rejects for unknown ids and for locked entries. */
  update(id: string, patch: Partial<Omit<Connection, 'id'>>): Promise<Connection>;
  /** Rejects for unknown ids and for locked entries. */
  remove(id: string): Promise<void>;
  getActiveId(): Promise<string | null>;
  getActive(): Promise<Connection | null>;
  /** Rejects for unknown ids. */
  setActive(id: string): Promise<void>;
  /**
   * Upsert the config's (locked/default) entries by id. null config = no-op.
   * A seeded isDefault entry becomes active when nothing is active yet, but
   * never steals an explicit user selection. Config wins for locked entries
   * (label/baseUrl updates apply on re-seed); user-added entries are
   * untouched.
   */
  seedFromRuntimeConfig(config: RuntimeConfig | null): Promise<void>;
  /**
   * Attach/clear credentials on ANY entry, including locked ones: a locked,
   * config-owned default assistant URL can be auth-fronted, and
   * update()/remove() rejecting locked entries wholesale left no path to
   * supply credentials for it. This bypasses ONLY the locked check, and ONLY
   * for `auth` — baseUrl/label/locked are untouched even when the target is
   * locked. Rejects for unknown ids.
   */
  setSecretRef(id: string, auth: ConnectionAuth): Promise<Connection>;
};

const ACTIVE_ID_KEY = 'activeId';

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Generate a connection id. `crypto.randomUUID()` is secure-context-only, so on
 * a plain-http LAN origin (the LAN-served tier this store supports) it is
 * undefined and calling it throws before a connection can be added. Fall back
 * to a v4 UUID built from `crypto.getRandomValues`, which IS available in
 * insecure contexts.
 */
function newConnectionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

/** In-memory storage backend — same semantics as the IndexedDB one. */
export function createMemoryStorage(): ConnectionStorage {
  const entries = new Map<string, Connection>();
  const meta = new Map<string, string>();
  let cryptoKey: CryptoKey | null = null;
  return {
    async getAll() {
      return [...entries.values()].map(clone);
    },
    async get(id) {
      const entry = entries.get(id);
      return entry ? clone(entry) : null;
    },
    async put(entry) {
      entries.set(entry.id, clone(redactEntryUrl(entry)));
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
    async getCryptoKey() {
      return cryptoKey;
    },
    async setCryptoKey(key) {
      cryptoKey = key;
    },
  };
}

// ── IndexedDB backend (browser) ──────────────────────────────────────────

const IDB_NAME = 'openpalm-ui-connections';
// STORE_KEYS holds the secret store's non-extractable AES-GCM key as an actual
// CryptoKey object (only IndexedDB's structured-clone area can carry one —
// getMeta/setMeta are JSON strings).
const IDB_VERSION = 1;
const STORE_CONNECTIONS = 'connections';
const STORE_META = 'meta';
const STORE_KEYS = 'keys';
const CRYPTO_KEY_ID = 'secret-store-aes-gcm-key';

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * F11 hardening: an IDB version bump with no `onblocked` handler and no
 * `versionchange` listener can leave a boot hung forever with no error
 * surfaced anywhere. `onblocked` rejects the open promise; `onVersionChange`
 * is invoked once a successfully-opened connection later receives its OWN
 * `versionchange` event (some other tab needs an upgrade): the connection
 * closes itself immediately so it can't go on to block that upgrade in turn,
 * and the caller uses the callback to drop its cached db promise so the NEXT
 * storage operation reopens fresh.
 */
function openDatabase(onVersionChange: () => void): Promise<IDBDatabase> {
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
      if (!db.objectStoreNames.contains(STORE_KEYS)) {
        db.createObjectStore(STORE_KEYS);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        onVersionChange();
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () =>
      reject(
        new Error(
          'IndexedDB upgrade blocked by another open connection (close other tabs of this app and retry)'
        )
      );
  });
}

/**
 * IndexedDB storage backend (raw IDB API, no deps). Lazily opens the database
 * on first use; each operation runs in its own short transaction.
 */
export function createIndexedDbStorage(): ConnectionStorage {
  let db: Promise<IDBDatabase> | null = null;
  const invalidate = (): void => {
    db = null;
  };
  const database = (): Promise<IDBDatabase> => {
    db ??= openDatabase(invalidate);
    return db;
  };
  const store = async (name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> =>
    (await database()).transaction(name, mode).objectStore(name);

  return {
    async getAll() {
      return idbRequest<Connection[]>(
        (await store(STORE_CONNECTIONS, 'readonly')).getAll() as IDBRequest<Connection[]>
      );
    },
    async get(id) {
      const found = await idbRequest<Connection | undefined>(
        (await store(STORE_CONNECTIONS, 'readonly')).get(id) as IDBRequest<Connection | undefined>
      );
      return found ?? null;
    },
    async put(entry) {
      await idbRequest((await store(STORE_CONNECTIONS, 'readwrite')).put(redactEntryUrl(entry)));
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
    async getCryptoKey() {
      const found = await idbRequest<CryptoKey | undefined>(
        (await store(STORE_KEYS, 'readonly')).get(CRYPTO_KEY_ID) as IDBRequest<CryptoKey | undefined>
      );
      return found ?? null;
    },
    async setCryptoKey(key) {
      await idbRequest((await store(STORE_KEYS, 'readwrite')).put(key, CRYPTO_KEY_ID));
    },
  };
}

// ── Store ────────────────────────────────────────────────────────────────

export function createConnectionStore(options: { storage: ConnectionStorage }): ConnectionStore {
  const { storage } = options;

  async function readEntry(id: string): Promise<Connection | null> {
    const stored = await storage.get(id);
    if (!stored) return null;
    const entry = redactEntryUrl(stored);
    if (entry.baseUrl !== stored.baseUrl) await storage.put(entry);
    return entry;
  }

  async function requireEntry(id: string): Promise<Connection> {
    const entry = await readEntry(id);
    if (!entry) throw new Error(`Unknown connection: ${id}`);
    return entry;
  }

  const store: ConnectionStore = {
    async list() {
      const stored = await storage.getAll();
      const entries = stored.map(redactEntryUrl);
      await Promise.all(
        entries.map((entry, index) =>
          entry.baseUrl === stored[index]?.baseUrl ? Promise.resolve() : storage.put(entry)
        )
      );
      return entries;
    },

    get(id) {
      return readEntry(id);
    },

    async add(input) {
      assertUrlHasNoUserinfo(input.baseUrl);
      const id = input.id ?? newConnectionId();
      if (await readEntry(id)) throw new Error(`Connection already exists: ${id}`);
      const entry: Connection = { ...input, id };
      await storage.put(entry);
      return clone(entry);
    },

    async update(id, patch) {
      if (patch.baseUrl !== undefined) assertUrlHasNoUserinfo(patch.baseUrl);
      const entry = await requireEntry(id);
      if (entry.locked) throw new Error(`Connection is locked (config-owned): ${id}`);
      const updated: Connection = { ...entry, ...patch, id };
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

    async setSecretRef(id, auth) {
      const entry = await requireEntry(id);
      const updated: Connection = { ...entry, auth, id };
      await storage.put(updated);
      return clone(updated);
    },

    getActiveId() {
      return storage.getMeta(ACTIVE_ID_KEY);
    },

    async getActive() {
      const id = await storage.getMeta(ACTIVE_ID_KEY);
      return id === null ? null : readEntry(id);
    },

    async setActive(id) {
      await requireEntry(id);
      await storage.setMeta(ACTIVE_ID_KEY, id);
    },

    async seedFromRuntimeConfig(config) {
      if (!config) return;
      const activeId = await storage.getMeta(ACTIVE_ID_KEY);
      const configIds = new Set(config.connections.map((entry) => entry.id));
      for (const existing of await storage.getAll()) {
        if (!existing.locked || configIds.has(existing.id)) continue;
        await storage.delete(existing.id);
        if (activeId === existing.id) {
          await storage.setMeta(ACTIVE_ID_KEY, null);
        }
      }
      for (const entry of config.connections) {
        const seededEntry = redactEntryUrl(entry);
        const existing = await readEntry(entry.id);
        // Config wins for the entries it owns (locked), including on re-seed; a
        // same-id entry the user somehow owns is left alone.
        if (!existing) {
          await storage.put(clone(seededEntry));
        } else if (existing.locked) {
          // Config refreshes the fields it owns (baseUrl/label/…), but a user
          // may have attached credentials to this locked entry via
          // setSecretRef; the config's locked entries always ship
          // auth:{mode:'none'}, so a wholesale rewrite would silently drop
          // those creds on every reload. Preserve a user-supplied non-none
          // auth across the reseed.
          const seeded = clone(seededEntry);
          const preserveAuth = existing.auth && existing.auth.mode !== 'none';
          await storage.put(preserveAuth ? { ...seeded, auth: existing.auth } : seeded);
        }
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
 * static server ships the file beside the build; the app holds no other
 * trusted origin at boot). Absent (404), unreachable (offline), or malformed
 * -> null; never throws, so an offline PWA boot still reaches the stored
 * connection list.
 */
export async function loadRuntimeConfig(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<RuntimeConfig | null> {
  try {
    const response = await fetchImpl('/runtime-config.json', {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'omit',
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as { connections?: unknown } | null;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.connections)) return null;
    return adaptRuntimeConfigForBrowser(parsed as RuntimeConfig);
  } catch {
    return null;
  }
}
