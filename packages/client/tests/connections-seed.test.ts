/**
 * P5b (#555) RED — runtime-config.json loading and locked/default seeding +
 * the offline read path (P5b item 2, plan §6.6/§6.10/§6.11).
 *
 * Boot flow pinned here:
 *   1. loadRuntimeConfig() fetches '/runtime-config.json' from the app's OWN
 *      origin (relative URL — the static server ships the file beside the
 *      build; the assistant container writes it in P5d). Absent (404),
 *      unreachable (offline), or malformed -> null. NEVER throws: an offline
 *      PWA boot must reach the stored connection list (plan §6.10 "offline
 *      launch shows the shell + saved connections, not a blank page").
 *   2. store.seedFromRuntimeConfig(config) upserts the config's entries by
 *      their stable ids:
 *        - null config = no-op,
 *        - re-seeding is idempotent (no duplicates),
 *        - config wins for locked entries (label/url updates apply on
 *          re-seed) — the container owns them,
 *        - user-added entries are untouched,
 *        - a seeded isDefault entry becomes active when nothing is active
 *          yet, but NEVER steals an explicit user selection.
 *   3. Reads (list/get/getActive) hit only the storage backend — no network.
 *
 * RED until src/lib/connections/index.ts exists: every test fails with
 * "Cannot find module …/src/lib/connections/index.ts" (missing feature).
 */
import { describe, expect, test } from 'bun:test';
import {
  type ConnectionEntry,
  loadConnectionsModule,
  type RuntimeConfig
} from './helpers/contract.ts';
import { jsonResponse, recordingFetch, rejectingFetch } from './helpers/mocks.ts';

async function withLocationHost<T>(hostname: string, run: () => Promise<T>): Promise<T> {
  const originalLocation = globalThis.location;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { hostname }
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: originalLocation
    });
  }
}

function seededEntry(overrides: Partial<ConnectionEntry> = {}): ConnectionEntry {
  return {
    id: 'seed-local-opencode',
    label: 'This assistant',
    kind: 'local-opencode',
    url: 'http://127.0.0.1:4096',
    auth: { mode: 'none' },
    isDefault: true,
    locked: true,
    ...overrides
  };
}

async function storeWithBackend() {
  const { createMemoryStorage, createConnectionStore } = await loadConnectionsModule();
  const storage = createMemoryStorage();
  return { storage, store: createConnectionStore({ storage }) };
}

describe('loadRuntimeConfig (P5b item 2)', () => {
  test("GETs '/runtime-config.json' from the app's own origin and parses it", async () => {
    const { loadRuntimeConfig } = await loadConnectionsModule();
    const config: RuntimeConfig = { connections: [seededEntry()] };
    const { fetch, calls } = recordingFetch(() => jsonResponse(config));
    const loaded = await loadRuntimeConfig(fetch);
    expect(calls.length).toBe(1);
    // Relative URL: the file MUST come from the serving origin, never from a
    // connection URL — the client holds no other trusted origin at boot.
    expect(calls[0].url).toBe('/runtime-config.json');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].credentials).toBe('omit');
    expect(loaded).toEqual(config);
  });

  test('absent file (404) means no default: resolves null, does not throw', async () => {
    const { loadRuntimeConfig } = await loadConnectionsModule();
    const { fetch } = recordingFetch(() => new Response('not found', { status: 404 }));
    expect(await loadRuntimeConfig(fetch)).toBeNull();
  });

  test('offline (fetch rejects) resolves null, does not throw', async () => {
    const { loadRuntimeConfig } = await loadConnectionsModule();
    expect(await loadRuntimeConfig(rejectingFetch('offline'))).toBeNull();
  });

  test('malformed JSON resolves null', async () => {
    const { loadRuntimeConfig } = await loadConnectionsModule();
    const { fetch } = recordingFetch(
      () => new Response('<html>SPA fallback</html>', { status: 200 })
    );
    expect(await loadRuntimeConfig(fetch)).toBeNull();
  });

  test('valid JSON without a connections array is malformed: resolves null', async () => {
    const { loadRuntimeConfig } = await loadConnectionsModule();
    const { fetch } = recordingFetch(() => jsonResponse({ unexpected: true }));
    expect(await loadRuntimeConfig(fetch)).toBeNull();
  });

  test('rewrites locked loopback default URLs to the current LAN browser host', async () => {
    const { loadRuntimeConfig } = await loadConnectionsModule();
    const config: RuntimeConfig = {
      connections: [
        seededEntry({ url: 'http://127.0.0.1:3800' }),
        seededEntry({ id: 'remote', locked: false, url: 'http://127.0.0.1:4900' })
      ]
    };
    const { fetch } = recordingFetch(() => jsonResponse(config));

    const loaded = await withLocationHost('192.168.1.10', () => loadRuntimeConfig(fetch));

    expect(loaded?.connections[0]?.url).toBe('http://192.168.1.10:3800/');
    expect(loaded?.connections[1]?.url).toBe('http://127.0.0.1:4900');
  });

  test('keeps locked loopback default URLs unchanged on localhost clients', async () => {
    const { loadRuntimeConfig } = await loadConnectionsModule();
    const config: RuntimeConfig = { connections: [seededEntry({ url: 'http://127.0.0.1:3800' })] };
    const { fetch } = recordingFetch(() => jsonResponse(config));

    const loaded = await withLocationHost('127.0.0.1', () => loadRuntimeConfig(fetch));

    expect(loaded?.connections[0]?.url).toBe('http://127.0.0.1:3800');
  });

  test('redacts legacy userinfo from runtime connection and host-link URLs', async () => {
    const { loadRuntimeConfig } = await loadConnectionsModule();
    const config: RuntimeConfig = {
      connections: [
        seededEntry({ url: 'http://legacy-user:legacy-password@127.0.0.1:3800' }),
      ],
      hostUrl: 'http://host-user:host-password@127.0.0.1:3880/host',
    };
    const { fetch } = recordingFetch(() => jsonResponse(config));

    const loaded = await loadRuntimeConfig(fetch);
    const serialized = JSON.stringify(loaded);

    expect(loaded?.connections[0]?.url).toBe('http://127.0.0.1:3800');
    expect(loaded?.hostUrl).toBe('http://127.0.0.1:3880/host');
    expect(serialized).not.toContain('legacy-user');
    expect(serialized).not.toContain('legacy-password');
    expect(serialized).not.toContain('host-user');
    expect(serialized).not.toContain('host-password');
  });
});

describe('seedFromRuntimeConfig (P5b item 2 — locked default)', () => {
  test('null config is a no-op', async () => {
    const { store } = await storeWithBackend();
    await store.seedFromRuntimeConfig(null);
    expect(await store.list()).toEqual([]);
    expect(await store.getActiveId()).toBeNull();
  });

  test('seeds the config entries under their stable ids', async () => {
    const { store } = await storeWithBackend();
    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });
    expect(await store.get('seed-local-opencode')).toEqual(seededEntry());
    expect((await store.list()).length).toBe(1);
  });

  test('a seeded isDefault entry becomes active when nothing is active yet', async () => {
    const { store } = await storeWithBackend();
    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });
    expect(await store.getActiveId()).toBe('seed-local-opencode');
    expect((await store.getActive())?.locked).toBe(true);
  });

  test('re-seeding is idempotent and config wins for locked entries (label/url refresh)', async () => {
    // The container rewrote runtime-config.json (new port, new label); the
    // next boot must apply it to the locked entry without duplicating it.
    const { store } = await storeWithBackend();
    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });
    await store.seedFromRuntimeConfig({
      connections: [seededEntry({ label: 'Renamed by config', url: 'http://127.0.0.1:5096' })]
    });
    const all = await store.list();
    expect(all.length).toBe(1);
    expect(all[0]).toEqual(
      seededEntry({ label: 'Renamed by config', url: 'http://127.0.0.1:5096' })
    );
  });

  test('re-seeding preserves user-attached credentials on a locked entry (Codex review of PR #562)', async () => {
    // E6 lets a user attach Basic/Bearer creds to a locked, config-owned
    // assistant/guardian via setSecretRef(). But every boot re-runs
    // seedFromRuntimeConfig(), whose locked entries always ship
    // auth:{mode:'none'} (the container never mints the user's creds). A
    // wholesale rewrite would drop the secretRef on the next reload, silently
    // reverting the connection to unauthenticated — defeating E6 in exactly
    // the scenario it exists for. Config still wins for label/url; only the
    // user-supplied auth is preserved.
    const { store } = await storeWithBackend();
    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });
    await store.setSecretRef('seed-local-opencode', { mode: 'basic', secretRef: 'sec_user' });

    await store.seedFromRuntimeConfig({
      connections: [seededEntry({ label: 'Renamed by config', url: 'http://127.0.0.1:5096' })]
    });

    const entry = await store.get('seed-local-opencode');
    // User credentials survive the reseed...
    expect(entry?.auth).toEqual({ mode: 'basic', secretRef: 'sec_user' });
    // ...while config still refreshes the fields it owns.
    expect(entry?.label).toBe('Renamed by config');
    expect(entry?.url).toBe('http://127.0.0.1:5096');
    expect((await store.list()).length).toBe(1);
  });

  test('seeding never steals an explicit user selection', async () => {
    const { store } = await storeWithBackend();
    const mine = await store.add({
      label: 'My remote',
      kind: 'remote-opencode',
      url: 'https://gw.example',
      auth: { mode: 'basic', secretRef: 'sec_1' }
    });
    await store.setActive(mine.id);
    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });
    expect(await store.getActiveId()).toBe(mine.id);
  });

  test('seeding leaves user-added entries untouched', async () => {
    const { store } = await storeWithBackend();
    const mine = await store.add({
      id: 'conn-user',
      label: 'My remote',
      kind: 'remote-opencode',
      url: 'https://gw.example',
      auth: { mode: 'bearer', secretRef: 'sec_2' }
    });
    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });
    expect(await store.get('conn-user')).toEqual(mine);
    expect((await store.list()).length).toBe(2);
  });

  test('re-seeding prunes locked entries that disappeared from runtime-config.json', async () => {
    const { store } = await storeWithBackend();
    await store.seedFromRuntimeConfig({
      connections: [seededEntry(), seededEntry({ id: 'seed-removed', label: 'Old lock' })]
    });

    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });

    expect(await store.get('seed-local-opencode')).toEqual(seededEntry());
    expect(await store.get('seed-removed')).toBeNull();
    expect(await store.list()).toEqual([seededEntry()]);
  });

  test('re-seeding prunes a removed locked active entry and clears the active selection', async () => {
    const { store } = await storeWithBackend();
    const removed = seededEntry({ id: 'seed-removed', label: 'Old lock', isDefault: false });
    await store.seedFromRuntimeConfig({ connections: [removed] });
    await store.setActive(removed.id);

    await store.seedFromRuntimeConfig({ connections: [seededEntry({ isDefault: false })] });

    expect(await store.get(removed.id)).toBeNull();
    expect(await store.getActiveId()).toBeNull();
  });

  test('seeded locked entries stay immutable through the store API', async () => {
    const { store } = await storeWithBackend();
    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });
    expect(store.update('seed-local-opencode', { url: 'http://evil.example' })).rejects.toThrow();
    expect(store.remove('seed-local-opencode')).rejects.toThrow();
    expect((await store.get('seed-local-opencode'))?.url).toBe('http://127.0.0.1:4096');
  });
});

describe('offline read path (P5b item 2, plan §6.10)', () => {
  test('offline boot: loadRuntimeConfig -> null, seed(null) no-op, stored connections still readable', async () => {
    // Previous (online) session stored connections; this boot is offline.
    const { createMemoryStorage, createConnectionStore, loadRuntimeConfig } =
      await loadConnectionsModule();
    const storage = createMemoryStorage();
    const online = createConnectionStore({ storage });
    await online.seedFromRuntimeConfig({ connections: [seededEntry()] });
    const mine = await online.add({
      id: 'conn-user',
      label: 'My remote',
      kind: 'remote-opencode',
      url: 'https://gw.example',
      auth: { mode: 'basic', secretRef: 'sec_1' }
    });

    // Reload with no network at all.
    const config = await loadRuntimeConfig(rejectingFetch('offline'));
    expect(config).toBeNull();
    const offline = createConnectionStore({ storage });
    await offline.seedFromRuntimeConfig(config);

    const list = await offline.list();
    expect(list).toContainEqual(seededEntry());
    expect(list).toContainEqual(mine);
    expect(await offline.getActiveId()).toBe('seed-local-opencode');
  });
});
