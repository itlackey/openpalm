/**
 * Client boot (P5b, #555): one storage backend + one ConnectionStore +
 * one SecretStore per browsing session, seeded once from the origin's
 * runtime-config.json (plan §6.6 — the assistant container writes the file
 * beside the static build in P5d; absent file = no default connection).
 *
 * Every route awaits getClientBoot(), so the seed runs exactly once no
 * matter which page the SPA fallback lands on first. Offline boots resolve
 * too: loadRuntimeConfig() -> null -> seed no-op -> stored connections
 * remain readable (plan §6.10).
 */
import {
  type ConnectionStorage,
  type ConnectionStore,
  createConnectionStore,
  createIndexedDbStorage,
  createMemoryStorage,
  loadRuntimeConfig,
} from './connections/index.js';
import { createSecretStore, type SecretStore } from './connections/secrets.js';

export type ClientBoot = {
  store: ConnectionStore;
  secrets: SecretStore;
};

let bootPromise: Promise<ClientBoot> | null = null;

function pickStorage(): ConnectionStorage {
  // Some private-browsing modes refuse IndexedDB entirely; degrade to a
  // session-only in-memory backend rather than a blank page.
  try {
    if (typeof indexedDB !== 'undefined') return createIndexedDbStorage();
  } catch {
    // fall through
  }
  return createMemoryStorage();
}

export function getClientBoot(): Promise<ClientBoot> {
  bootPromise ??= (async () => {
    const storage = pickStorage();
    const store = createConnectionStore({ storage });
    await store.seedFromRuntimeConfig(await loadRuntimeConfig());
    return { store, secrets: createSecretStore(storage) };
  })();
  return bootPromise;
}
