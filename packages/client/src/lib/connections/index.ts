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

import { isLoopbackHost } from './url-policy.js';

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
  /**
   * Optional link back to the host UI (review 2026-07-10 §A2/H4), e.g.
   * `http://127.0.0.1:3880/host`. Written by Electron/CLI
   * (`writeClientRuntimeConfig`'s `hostUrl` option) when a host process
   * exists alongside the client server; absent for container-only
   * deployments with no host UI to point at. `+layout.svelte` renders a
   * "Manage assistant" link only when this is present.
   */
  hostUrl?: string;
};

function rewriteLoopbackUrlForBrowserHost(rawUrl: string): string {
  const locationLike = globalThis.location;
  if (!locationLike || isLoopbackHost(locationLike.hostname)) return rawUrl;
  try {
    const url = new URL(rawUrl);
    if (!isLoopbackHost(url.hostname)) return rawUrl;
    url.hostname = locationLike.hostname;
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function adaptRuntimeConfigForBrowser(config: RuntimeConfig): RuntimeConfig {
  return {
    connections: config.connections.map((entry) => ({
      ...entry,
      url: entry.locked ? rewriteLoopbackUrlForBrowserHost(entry.url) : entry.url,
    })),
    // hostUrl is Electron/CLI-written and always a loopback URL local to the
    // machine running the host process — same rewrite as locked connection
    // entries, so a LAN-accessed client still points the link at the visited
    // hostname rather than an unreachable 127.0.0.1.
    ...(config.hostUrl ? { hostUrl: rewriteLoopbackUrlForBrowserHost(config.hostUrl) } : {}),
  };
}

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
  /**
   * Structured-clone value area for the secret store's non-extractable
   * AES-GCM wrapping key (E7, review 2026-07-10 §E7). `getMeta`/`setMeta`
   * round-trip JSON strings and cannot carry an actual CryptoKey object —
   * IndexedDB's structured-clone algorithm can, so this is a distinct area
   * rather than an overload. Returns null until a key has been generated.
   */
  getCryptoKey(): Promise<CryptoKey | null>;
  setCryptoKey(key: CryptoKey): Promise<void>;
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
  /**
   * Attach/clear credentials on ANY entry, including locked ones (E6, review
   * 2026-07-10 §E6): a locked, config-owned default assistant URL can be
   * auth-fronted, and update()/remove() rejecting locked entries wholesale
   * left no path to supply credentials for it. This bypasses ONLY the
   * locked check, and ONLY for `auth` — url/label/kind/locked are untouched
   * even when the target is locked. Rejects for unknown ids.
   */
  setSecretRef(id: string, auth: ConnectionEntry['auth']): Promise<ConnectionEntry>;
};

const ACTIVE_ID_KEY = 'activeId';

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** In-memory storage backend — same semantics as the IndexedDB one. */
export function createMemoryStorage(): ConnectionStorage {
  const entries = new Map<string, ConnectionEntry>();
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
    async getCryptoKey() {
      return cryptoKey;
    },
    async setCryptoKey(key) {
      cryptoKey = key;
    },
  };
}

// ── IndexedDB backend (browser) ──────────────────────────────────────────

const IDB_NAME = 'openpalm-client';
// Bumped 1 -> 2 for E7 (review 2026-07-10 §E7): STORE_KEYS holds the secret
// store's non-extractable AES-GCM key as an actual CryptoKey object (only
// IndexedDB's structured-clone area can carry one — getMeta/setMeta are
// JSON strings). onupgradeneeded fires for existing v1 databases too, so
// upgrading installs gain the store with no data loss.
const IDB_VERSION = 2;
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
 * F11 (review 2026-07-10 §F11, PR #562 fix round): IDB_VERSION was bumped
 * 1 -> 2 for E7 with no `onblocked` handler and no `versionchange` listener
 * on the opened connection. If another tab holds an older-version
 * connection open, the upgrade transaction can't start: `onupgradeneeded`/
 * `onsuccess`/`onerror` never fire — only `onblocked` does — and without a
 * handler for it this Promise never settled, so getClientBoot() hung
 * forever with no error surfaced anywhere.
 *
 * `onVersionChange` is invoked once a successfully-opened connection later
 * receives its OWN `versionchange` event (some other tab needs a further
 * upgrade): the connection closes itself immediately so it can't go on to
 * block that upgrade in turn, and the caller uses the callback to drop its
 * cached db promise so the NEXT storage operation reopens fresh.
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
 * IndexedDB storage backend (raw IDB API, no deps). Lazily opens the
 * database on first use; each operation runs in its own short transaction.
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

    async setSecretRef(id, auth) {
      const entry = await requireEntry(id);
      const updated: ConnectionEntry = { ...entry, auth, id };
      await storage.put(updated);
      return clone(updated);
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
        const existing = await storage.get(entry.id);
        // Config wins for the entries it owns (locked), including on
        // re-seed; a same-id entry the user somehow owns is left alone.
        if (!existing) {
          await storage.put(clone(entry));
        } else if (existing.locked) {
          // Config refreshes the fields it owns (url/label/…), but a user may
          // have attached credentials to this locked entry via setSecretRef
          // (E6); the config's locked entries always ship auth:{mode:'none'},
          // so a wholesale rewrite would silently drop those creds on every
          // reload. Preserve a user-supplied non-none auth across the reseed.
          const seeded = clone(entry);
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
