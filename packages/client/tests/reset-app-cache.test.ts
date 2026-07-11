/**
 * H3 (client half) [LOW] (review 2026-07-10 §H3) — "Installed/cached client
 * PWA can pin a stale or dead build" has no cache-escape affordance
 * anywhere: no `clearStorageData` in Electron (out of scope for this
 * package), and no reset action in the client itself. This pins the client
 * half: a pure, dependency-injected `resetAppCache()` that unregisters
 * every service-worker registration, deletes every Cache Storage bucket,
 * and reloads — the layout wires a button to it (see
 * tests/layout-markup.test.ts's H3 assertions).
 *
 * RED until src/lib/reset-app-cache.ts exists.
 */
import { describe, expect, test } from 'bun:test';

type FakeRegistration = { unregister: () => Promise<boolean> };
type FakeServiceWorkerContainer = { getRegistrations: () => Promise<FakeRegistration[]> };
type FakeCacheStorage = { keys: () => Promise<string[]>; delete: (key: string) => Promise<boolean> };

async function loadModule() {
  return import('../src/lib/reset-app-cache.ts');
}

describe('resetAppCache() (H3)', () => {
  test('unregisters every service-worker registration', async () => {
    const { resetAppCache } = await loadModule();
    const unregistered: string[] = [];
    const registrations: FakeRegistration[] = [
      { unregister: async () => { unregistered.push('a'); return true; } },
      { unregister: async () => { unregistered.push('b'); return true; } },
    ];
    const serviceWorker: FakeServiceWorkerContainer = { getRegistrations: async () => registrations };
    let reloaded = false;
    await resetAppCache({
      serviceWorker: serviceWorker as unknown as ServiceWorkerContainer,
      caches: { keys: async () => [], delete: async () => true } as unknown as CacheStorage,
      reload: () => { reloaded = true; },
    });
    expect(unregistered.sort()).toEqual(['a', 'b']);
    expect(reloaded).toBe(true);
  });

  test('deletes every Cache Storage bucket by key', async () => {
    const { resetAppCache } = await loadModule();
    const deleted: string[] = [];
    const cachesApi: FakeCacheStorage = {
      keys: async () => ['openpalm-public-get', 'runtime-config', 'workbox-precache-v2'],
      delete: async (key) => { deleted.push(key); return true; },
    };
    await resetAppCache({
      serviceWorker: { getRegistrations: async () => [] } as unknown as ServiceWorkerContainer,
      caches: cachesApi as unknown as CacheStorage,
      reload: () => {},
    });
    expect(deleted.sort()).toEqual(['openpalm-public-get', 'runtime-config', 'workbox-precache-v2']);
  });

  test('reloads even when there is no service worker support at all', async () => {
    const { resetAppCache } = await loadModule();
    let reloaded = false;
    await resetAppCache({
      serviceWorker: undefined,
      caches: { keys: async () => [], delete: async () => true } as unknown as CacheStorage,
      reload: () => { reloaded = true; },
    });
    expect(reloaded).toBe(true);
  });

  test('reloads even when Cache Storage is unavailable', async () => {
    const { resetAppCache } = await loadModule();
    let reloaded = false;
    await resetAppCache({
      serviceWorker: { getRegistrations: async () => [] } as unknown as ServiceWorkerContainer,
      caches: undefined,
      reload: () => { reloaded = true; },
    });
    expect(reloaded).toBe(true);
  });

  test('still reloads even if one unregister() call rejects (best-effort)', async () => {
    const { resetAppCache } = await loadModule();
    const registrations: FakeRegistration[] = [
      { unregister: async () => { throw new Error('nope'); } },
      { unregister: async () => true },
    ];
    let reloaded = false;
    await resetAppCache({
      serviceWorker: { getRegistrations: async () => registrations } as unknown as ServiceWorkerContainer,
      caches: { keys: async () => [], delete: async () => true } as unknown as CacheStorage,
      reload: () => { reloaded = true; },
    });
    expect(reloaded).toBe(true);
  });

  test('still reloads even if one caches.delete() call rejects (best-effort)', async () => {
    const { resetAppCache } = await loadModule();
    let reloaded = false;
    await resetAppCache({
      serviceWorker: { getRegistrations: async () => [] } as unknown as ServiceWorkerContainer,
      caches: {
        keys: async () => ['a', 'b'],
        delete: async (key: string) => { if (key === 'a') throw new Error('nope'); return true; },
      } as unknown as CacheStorage,
      reload: () => { reloaded = true; },
    });
    expect(reloaded).toBe(true);
  });
});
