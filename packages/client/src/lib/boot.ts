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
  /**
   * Review 2026-07-10 §A2/H4: link back to the host UI, when the runtime
   * config carries one (Electron/CLI write it; container-only deployments
   * omit it). `undefined` means render no "Manage assistant" link.
   */
  hostUrl?: string;
};

let bootPromise: Promise<ClientBoot> | null = null;

function pickStorage(): { storage: ConnectionStorage; persistent: boolean } {
  // Some private-browsing modes refuse IndexedDB entirely; degrade to a
  // session-only in-memory backend rather than a blank page.
  try {
    if (typeof indexedDB !== 'undefined') {
      return { storage: createIndexedDbStorage(), persistent: true };
    }
  } catch {
    // fall through
  }
  return { storage: createMemoryStorage(), persistent: false };
}

async function bootWithStorage(storage: ConnectionStorage): Promise<ClientBoot> {
  const store = createConnectionStore({ storage });
  const config = await loadRuntimeConfig();
  await store.seedFromRuntimeConfig(config);
  return { store, secrets: createSecretStore(storage), hostUrl: config?.hostUrl };
}

export function getClientBoot(): Promise<ClientBoot> {
  bootPromise ??= (async () => {
    const selected = pickStorage();
    try {
      return await bootWithStorage(selected.storage);
    } catch (error) {
      if (!selected.persistent) throw error;
      return bootWithStorage(createMemoryStorage());
    }
  })().catch((error) => {
    bootPromise = null;
    throw error;
  });
  return bootPromise;
}
