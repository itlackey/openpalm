/**
 * Browser-owned connection store (Phase 3a — "One UI, delete the split").
 *
 * Connection records persist behind a storage abstraction so the same store
 * logic runs over IndexedDB in the browser (offline-readable) and over an
 * in-memory backend in tests. The store API is async throughout (IndexedDB is
 * async) and keeps NO state in store-instance fields — a page reload
 * constructs a new store over the same backend and must see identical state.
 *
 * Locked/default entries are seeded from process or static runtime config
 * fetched from the app's own origin at boot. Absent config = no default.
 *
 * The Connection shape is `{ id, label, baseUrl, auth }` with auth narrowed to
 * none | basic (Guardian is a transparent OpenCode proxy — Basic is the only
 * connection credential model).
 */

import { parseUiRuntimeConfig } from '@openpalm/lib/control-plane/ui-runtime-config-schema.js';
import { randomId } from '../random-id.js';
import { hasSameLoopbackPort, isLoopbackHost, redactUrlUserinfo } from './url-policy.js';

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

/** Shape shared by the process endpoint and static assistant fallback. */
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

function isMixedContentTarget(rawUrl: string): boolean {
  if (globalThis.location?.protocol !== 'https:') return false;
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' && !isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
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
    connections: config.connections.flatMap((entry) => {
      const baseUrl = entry.locked
        ? rewriteLoopbackUrlForBrowserHost(entry.baseUrl)
        : redactUrlUserinfo(entry.baseUrl);
      if (isMixedContentTarget(baseUrl)) return [];
      return [{ ...redactEntryUrl(entry), baseUrl }];
    }),
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
  /** Clear the active selection (no-op when nothing is active). */
  clearActive(): Promise<void>;
  /**
   * Upsert the config's (locked/default) entries by id. null config = no-op.
   * A loopback entry is not seeded when that port is already represented under
   * another loopback host spelling.
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
const LEGACY_DISCOVERY_LABELS = new Set(['Local assistant', 'Local assistant (guardian)']);

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Connection/secret-ref id minting. Delegates to $lib/random-id so the
 * insecure-context guard (crypto.randomUUID is secure-context-only and would
 * throw on the plain-http LAN tier) lives in ONE place. Exported so the
 * connections form mints secretRefs through the same guard.
 */
export { randomId as newConnectionId } from '../random-id.js';

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
      const id = input.id ?? randomId();
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

    async clearActive() {
      await storage.setMeta(ACTIVE_ID_KEY, null);
    },

    async seedFromRuntimeConfig(config) {
      if (!config) return;
      let activeId = await storage.getMeta(ACTIVE_ID_KEY);
      const configIds = new Set(config.connections.map((entry) => entry.id));
      for (const existing of await storage.getAll()) {
        if (!existing.locked || configIds.has(existing.id)) continue;
        await storage.delete(existing.id);
        if (activeId === existing.id) {
          await storage.setMeta(ACTIVE_ID_KEY, null);
          activeId = null;
        }
      }
      const configAliases = new Map<string, string>();
      for (const entry of config.connections) {
        const seededEntry = redactEntryUrl(entry);
        const existing = await readEntry(entry.id);
        const equivalent = (await storage.getAll()).find(
          (candidate) =>
            candidate.id !== entry.id && hasSameLoopbackPort(candidate.baseUrl, seededEntry.baseUrl)
        );
        if (equivalent) {
          configAliases.set(entry.id, equivalent.id);
          if (existing?.locked) await storage.delete(existing.id);
          if (activeId === entry.id) {
            await storage.setMeta(ACTIVE_ID_KEY, equivalent.id);
            activeId = equivalent.id;
          }
          // Migrate entries created by older auto-discovery without changing a
          // label the user chose for the same local assistant.
          if (!equivalent.locked && LEGACY_DISCOVERY_LABELS.has(equivalent.label)) {
            await storage.put({ ...equivalent, label: seededEntry.label });
          }
          continue;
        }
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
      const fallbackId = fallback ? (configAliases.get(fallback.id) ?? fallback.id) : null;
      if (fallbackId && (await storage.get(fallbackId))) {
        await storage.setMeta(ACTIVE_ID_KEY, fallbackId);
      }
    },
  };

  return store;
}

// ── Runtime config ───────────────────────────────────────────────────────

/**
 * Prefer the host process's per-launch config endpoint. A 404 (or an endpoint
 * unavailable on an older/static server) falls back to the assistant
 * container's `/runtime-config.json`. A present but invalid process config
 * fails closed instead of reviving a stale static locked connection.
 */
export async function loadRuntimeConfig(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<RuntimeConfig | null> {
  const requestInit: RequestInit = {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
  };

  let processResponse: Response | null = null;
  try {
    processResponse = await fetchImpl('/api/runtime-config', requestInit);
  } catch {
    // Static-only servers have no process endpoint.
  }

  if (processResponse && processResponse.status !== 404) {
    if (!processResponse.ok) return null;
    try {
      const config = parseUiRuntimeConfig(await processResponse.json());
      return config ? adaptRuntimeConfigForBrowser(config) : null;
    } catch {
      return null;
    }
  }

  try {
    const response = await fetchImpl('/runtime-config.json', requestInit);
    if (!response.ok) return null;
    const config = parseUiRuntimeConfig(await response.json());
    return config ? adaptRuntimeConfigForBrowser(config) : null;
  } catch {
    return null;
  }
}
