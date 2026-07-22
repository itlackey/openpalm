/**
 * Browser connection boot (Phase 3b — "One UI, delete the split").
 *
 * One storage backend + one ConnectionStore + one SecretStore + one direct
 * transport per browsing session, created lazily on first access. The chat
 * layer (`$lib/api/chat.ts`, `$lib/chat/session-events.ts`) and the connection
 * switcher (`$lib/endpoints-state.svelte.ts`) all share these singletons so the
 * browser owns connections and talks to OpenCode/Guardian DIRECTLY — no host
 * proxy, no admin cookie.
 *
 * The transport reads the active connection SYNCHRONOUSLY from a snapshot the
 * connection store owner (`endpoints-state`) keeps in sync via
 * `setActiveConnection()`. The store's own `getActive()` is async (IndexedDB),
 * so it can't back the transport's synchronous `getConnection` directly.
 *
 * IndexedDB is the persistent backend; private-browsing modes that refuse it
 * degrade to an in-memory backend (session-only) rather than a blank page —
 * mirroring the client's `pickStorage`.
 */
import {
  createConnectionStore,
  createIndexedDbStorage,
  createMemoryStorage,
  type Connection,
  type ConnectionStorage,
  type ConnectionStore,
} from './store.js';
import { createSecretStore, type SecretStore } from './secrets.js';
import { authorizationHeader, createDirectTransport, type DirectTransport } from '../transport/direct.js';

let store: ConnectionStore | null = null;
let secrets: SecretStore | null = null;
let transport: DirectTransport | null = null;
let storage: ConnectionStorage | null = null;
export type ConnectionStorageMode = 'persistent' | 'session-only';
let storageMode: ConnectionStorageMode | 'checking' = 'checking';
/** Synchronous snapshot of the active connection for the transport. */
let activeConnection: Connection | null = null;

/**
 * Some private-browsing modes refuse IndexedDB entirely; degrade to a
 * session-only in-memory backend rather than a blank page (mirrors the
 * client's pickStorage).
 */
function pickStorage(): ConnectionStorage {
  const memory = createMemoryStorage();
  try {
    if (typeof indexedDB === 'undefined') {
      storageMode = 'session-only';
      return memory;
    }
  } catch {
    storageMode = 'session-only';
    return memory;
  }

  const persistent = createIndexedDbStorage();
  let selected: Promise<ConnectionStorage> | null = null;
  const select = (): Promise<ConnectionStorage> => {
    selected ??= persistent.getAll().then(
      () => {
        storageMode = 'persistent';
        return persistent;
      },
      () => {
        storageMode = 'session-only';
        return memory;
      }
    );
    return selected;
  };

  return {
    getAll: async () => (await select()).getAll(),
    get: async (id) => (await select()).get(id),
    put: async (entry) => (await select()).put(entry),
    updateConnection: async (id, update) => (await select()).updateConnection(id, update),
    removeConnectionState: async (id, allowLocked) =>
      (await select()).removeConnectionState(id, allowLocked),
    getMeta: async (key) => (await select()).getMeta(key),
    setMeta: async (key, value) => (await select()).setMeta(key, value),
		setActive: async (id) => (await select()).setActive(id),
		compareAndSetActive: async (expected, id) =>
			(await select()).compareAndSetActive(expected, id),
    getCryptoKey: async () => (await select()).getCryptoKey(),
    setCryptoKey: async (key) => (await select()).setCryptoKey(key),
  };
}

function ensure(): void {
  if (store && secrets && transport) return;
  storage = pickStorage();
  const connectionStore = createConnectionStore({ storage });
  const secretStore = createSecretStore(storage);
  const directTransport = createDirectTransport(
    () => activeConnection,
    async (connection) => {
      const resolved = await secretStore.resolveAuth(connection);
      // The transport's authHeaders already drops an undefined authorization.
      return { authorization: authorizationHeader(resolved) ?? undefined };
    }
  );
  store = connectionStore;
  secrets = secretStore;
  transport = directTransport;
}

export function getConnectionStore(): ConnectionStore {
  ensure();
  if (!store) throw new Error('Connection store failed to initialize.');
  return store;
}

export function getSecretStore(): SecretStore {
  ensure();
  if (!secrets) throw new Error('Secret store failed to initialize.');
  return secrets;
}

export function getTransport(): DirectTransport {
  ensure();
  if (!transport) throw new Error('Direct transport failed to initialize.');
  return transport;
}

/** Resolve whether this browsing session can persist connection state. */
export async function getConnectionStorageMode(): Promise<ConnectionStorageMode> {
  ensure();
  if (!storage) throw new Error('Connection storage failed to initialize.');
  await storage.getAll();
  return storageMode === 'persistent' ? 'persistent' : 'session-only';
}

/**
 * Point the direct transport at `connection` (or clear it). Called by the
 * connection-store owner (`endpoints-state`) on load/activate — a plain
 * function, no `$effect`, so the transport's synchronous `getConnection`
 * always sees the current active connection.
 */
export function setActiveConnection(connection: Connection | null): void {
  activeConnection = connection;
}
