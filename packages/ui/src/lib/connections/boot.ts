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
/** Synchronous snapshot of the active connection for the transport. */
let activeConnection: Connection | null = null;

/**
 * Some private-browsing modes refuse IndexedDB entirely; degrade to a
 * session-only in-memory backend rather than a blank page (mirrors the
 * client's pickStorage).
 */
function pickStorage(): ConnectionStorage {
  try {
    if (typeof indexedDB !== 'undefined') return createIndexedDbStorage();
  } catch {
    // fall through to memory
  }
  return createMemoryStorage();
}

function ensure(): void {
  if (store && secrets && transport) return;
  const storage = pickStorage();
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

/**
 * Point the direct transport at `connection` (or clear it). Called by the
 * connection-store owner (`endpoints-state`) on load/activate — a plain
 * function, no `$effect`, so the transport's synchronous `getConnection`
 * always sees the current active connection.
 */
export function setActiveConnection(connection: Connection | null): void {
  activeConnection = connection;
}
