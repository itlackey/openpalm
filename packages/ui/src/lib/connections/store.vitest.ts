/**
 * Connection store CRUD + active selection + runtime-config seeding, over the
 * in-memory backend (the tests are the spec for both backends, so everything
 * is async and nothing lives only in store-instance fields).
 *
 * The ui Connection shape is `{ id, label, baseUrl, auth }` with auth narrowed
 * to none | basic.
 */
import { describe, expect, test } from 'vitest';
import {
  createConnectionStore,
  createMemoryStorage,
  loadRuntimeConfig,
  type Connection,
  type NewConnectionInput,
  type RuntimeConfig,
} from './store.js';

function guardianInput(overrides: Partial<NewConnectionInput> = {}): NewConnectionInput {
  return {
    label: 'Home guardian',
    baseUrl: 'http://gw.example:8443',
    auth: { mode: 'basic', username: 'carol', secretRef: 'sec_1' },
    ...overrides,
  };
}

function freshStore() {
  const storage = createMemoryStorage();
  return { storage, store: createConnectionStore({ storage }) };
}

// ── Local fetch/location doubles ───────────────────────────────────────────

type RecordedRequest = {
  url: string;
  method: string;
  credentials: RequestCredentials | undefined;
  cache: RequestCache | undefined;
};

function recordingFetch(respond: (url: string) => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      credentials: init?.credentials,
      cache: init?.cache,
    });
    return respond(String(input));
  };
  return { fetch: impl as typeof globalThis.fetch, calls };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rejectingFetch(message = 'offline'): typeof globalThis.fetch {
  return (async () => {
    throw new TypeError(message);
  }) as unknown as typeof globalThis.fetch;
}

async function withLocationHost<T>(hostname: string, run: () => Promise<T>, protocol = 'http:'): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  // Include `origin` — a real Location always has one, and the same-origin
  // `/oc` seed resolves against it.
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { hostname, protocol, origin: `${protocol}//${hostname}` },
  });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'location', original);
    else delete (globalThis as Record<string, unknown>).location;
  }
}

function seededEntry(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'seed-local-opencode',
    label: 'Local assistant',
    baseUrl: 'http://127.0.0.1:4096',
    auth: { mode: 'none' },
    isDefault: true,
    locked: true,
    ...overrides,
  };
}

describe('connection store CRUD', () => {
  test('starts empty: list() is [] and get() of an unknown id is null', async () => {
    const { store } = freshStore();
    expect(await store.list()).toEqual([]);
    expect(await store.get('missing')).toBeNull();
  });

  test('add() returns the stored entry with a generated non-empty id and get() round-trips it', async () => {
    const { store } = freshStore();
    const added = await store.add(guardianInput());
    expect(typeof added.id).toBe('string');
    expect(added.id.length).toBeGreaterThan(0);
    expect(added).toMatchObject(guardianInput());
    expect(await store.get(added.id)).toEqual(added);
    expect(await store.list()).toEqual([added]);
  });

  test('add() generates distinct ids for successive entries', async () => {
    const { store } = freshStore();
    const first = await store.add(guardianInput({ label: 'One' }));
    const second = await store.add(guardianInput({ label: 'Two' }));
    expect(second.id).not.toBe(first.id);
    expect((await store.list()).length).toBe(2);
  });

  test('add() keeps an explicit id (runtime-config seeds depend on stable ids)', async () => {
    const { store } = freshStore();
    const added = await store.add(guardianInput({ id: 'conn-explicit' }));
    expect(added.id).toBe('conn-explicit');
    expect(await store.get('conn-explicit')).toEqual(added);
  });

  test('update() patches fields, persists the result, and returns the updated entry', async () => {
    const { store } = freshStore();
    const added = await store.add(guardianInput());
    const updated = await store.update(added.id, {
      label: 'Renamed',
      baseUrl: 'https://gw.example:9443',
    });
    expect(updated).toEqual({ ...added, label: 'Renamed', baseUrl: 'https://gw.example:9443' });
    expect(await store.get(added.id)).toEqual(updated);
  });

  test('updateWithPrevious() atomically returns the durable record it replaced', async () => {
    const storage = createMemoryStorage();
    const staleTab = createConnectionStore({ storage });
    const currentTab = createConnectionStore({ storage });
    const stale = await staleTab.add(guardianInput({ id: 'shared', auth: { mode: 'basic', username: 'a', secretRef: 'secret-a' } }));
    const current = await currentTab.update(stale.id, {
      auth: { mode: 'basic', username: 'b', secretRef: 'secret-b' },
    });

    const result = await staleTab.updateWithPrevious(stale.id, {
      auth: { mode: 'basic', username: 'c', secretRef: 'secret-c' },
    });

    expect(result.previous).toEqual(current);
    expect(result.updated.auth).toEqual({ mode: 'basic', username: 'c', secretRef: 'secret-c' });
    expect(await currentTab.get(stale.id)).toEqual(result.updated);
  });

  test('add and update reject URL userinfo before writing a connection record', async () => {
    const { store, storage } = freshStore();
    await expect(
      store.add(guardianInput({ baseUrl: 'https://url-user:url-password@gw.example' }))
    ).rejects.toThrow(/Authentication fields/);
    expect(await storage.getAll()).toEqual([]);

    const added = await store.add(guardianInput());
    await expect(
      store.update(added.id, { baseUrl: 'https://next-user:next-password@gw.example' })
    ).rejects.toThrow(/Authentication fields/);
    expect((await storage.get(added.id))?.baseUrl).toBe('http://gw.example:8443');
  });

  test('the low-level storage boundary strips userinfo from legacy-shaped writes', async () => {
    const { storage } = freshStore();
    await storage.put({
      ...guardianInput({ id: 'legacy-write' }),
      id: 'legacy-write',
      baseUrl: 'https://legacy-user:legacy-password@gw.example',
    });
    const raw = JSON.stringify(await storage.get('legacy-write'));
    expect(raw).not.toContain('legacy-user');
    expect(raw).not.toContain('legacy-password');
    expect((await storage.get('legacy-write'))?.baseUrl).toBe('https://gw.example');
  });

  test('update() rejects for an unknown id', async () => {
    const { store } = freshStore();
    await expect(store.update('missing', { label: 'x' })).rejects.toThrow();
  });

  test('update() rejects for a locked entry (config-owned)', async () => {
    const { store } = freshStore();
    const locked = await store.add(guardianInput({ id: 'conn-locked', locked: true }));
    await expect(store.update(locked.id, { label: 'tampered' })).rejects.toThrow();
    expect((await store.get(locked.id))?.label).toBe('Home guardian');
  });

  test('remove() deletes the entry', async () => {
    const { store } = freshStore();
    const added = await store.add(guardianInput());
		await store.setActive(added.id);
		await store.setLastSessionId(added.id, 'session-1');
    await expect(store.remove(added.id)).resolves.toEqual(added);
    expect(await store.get(added.id)).toBeNull();
    expect(await store.list()).toEqual([]);
		expect(await store.getActiveId()).toBeNull();
		expect(await store.getLastSessionId(added.id)).toBeNull();
  });

  test('remove() atomically returns the durable record removed after a stale read', async () => {
    const storage = createMemoryStorage();
    const staleTab = createConnectionStore({ storage });
    const currentTab = createConnectionStore({ storage });
    const stale = await staleTab.add(guardianInput({ id: 'shared', auth: { mode: 'basic', username: 'a', secretRef: 'secret-a' } }));
    const current = await currentTab.update(stale.id, {
      auth: { mode: 'basic', username: 'b', secretRef: 'secret-b' },
    });

    await expect(staleTab.remove(stale.id)).resolves.toEqual(current);
    expect(await currentTab.get(stale.id)).toBeNull();
  });

  test('remove() rejects for an unknown id', async () => {
    const { store } = freshStore();
    await expect(store.remove('missing')).rejects.toThrow();
  });

  test('remove() rejects for a locked entry and keeps it stored', async () => {
    const { store } = freshStore();
    const locked = await store.add(guardianInput({ id: 'conn-locked', locked: true }));
    await expect(store.remove(locked.id)).rejects.toThrow();
    expect(await store.get(locked.id)).not.toBeNull();
  });
});

describe('setSecretRef (locked entries can still receive credentials)', () => {
  test('attaches auth to a locked entry, touching nothing else', async () => {
    const { store } = freshStore();
    const locked = await store.add(
      guardianInput({ id: 'conn-locked', locked: true, baseUrl: 'http://default.example', auth: { mode: 'none' } })
    );
    const updated = await store.setSecretRef(locked.id, {
      mode: 'basic',
      username: 'carol',
      secretRef: 'sec_locked',
    });
    expect(updated.auth).toEqual({ mode: 'basic', username: 'carol', secretRef: 'sec_locked' });
    expect(updated.baseUrl).toBe('http://default.example');
    expect(updated.locked).toBe(true);
    expect(updated.label).toBe('Home guardian');
    expect(await store.get(locked.id)).toEqual(updated);
  });

  test('clears auth back to none on a locked entry', async () => {
    const { store } = freshStore();
    const locked = await store.add(
      guardianInput({ id: 'conn-locked', locked: true, auth: { mode: 'basic', username: 'carol', secretRef: 'sec_locked' } })
    );
    const updated = await store.setSecretRef(locked.id, { mode: 'none' });
    expect(updated.auth).toEqual({ mode: 'none' });
    expect(updated.locked).toBe(true);
  });

  test('works identically on unlocked entries (not a locked-only special case)', async () => {
    const { store } = freshStore();
    const added = await store.add(guardianInput());
    const updated = await store.setSecretRef(added.id, { mode: 'basic', username: 'dave', secretRef: 'sec_2' });
    expect(updated.auth).toEqual({ mode: 'basic', username: 'dave', secretRef: 'sec_2' });
  });

  test('rejects for an unknown id', async () => {
    const { store } = freshStore();
    await expect(store.setSecretRef('missing', { mode: 'none' })).rejects.toThrow();
  });

  test('the identity/baseUrl of a locked entry stays immutable via update() even after setSecretRef()', async () => {
    const { store } = freshStore();
    const locked = await store.add(guardianInput({ id: 'conn-locked', locked: true }));
    await store.setSecretRef(locked.id, { mode: 'basic', username: 'carol', secretRef: 'sec_1' });
    await expect(store.update(locked.id, { baseUrl: 'http://evil.example' })).rejects.toThrow();
    expect((await store.get(locked.id))?.baseUrl).toBe('http://gw.example:8443');
  });
});

describe('active connection selection', () => {
  test('nothing is active initially, and add() does not implicitly activate', async () => {
    const { store } = freshStore();
    expect(await store.getActiveId()).toBeNull();
    expect(await store.getActive()).toBeNull();
    await store.add(guardianInput());
    expect(await store.getActiveId()).toBeNull();
  });

  test('setActive() selects a stored entry; getActive() resolves it', async () => {
    const { store } = freshStore();
    const a = await store.add(guardianInput({ label: 'A' }));
    const b = await store.add(guardianInput({ label: 'B' }));
    await store.setActive(b.id);
    expect(await store.getActiveId()).toBe(b.id);
    expect(await store.getActive()).toEqual(b);
    await store.setActive(a.id);
    expect(await store.getActiveId()).toBe(a.id);
  });

  test('setActive() rejects for an unknown id and leaves the selection unchanged', async () => {
    const { store } = freshStore();
    const a = await store.add(guardianInput());
    await store.setActive(a.id);
    await expect(store.setActive('missing')).rejects.toThrow();
    expect(await store.getActiveId()).toBe(a.id);
  });

	test('compareAndSetActive() changes only the exact expected selection', async () => {
		const { store } = freshStore();
		const a = await store.add(guardianInput({ label: 'A' }));
		const b = await store.add(guardianInput({ label: 'B' }));
		await store.setActive(a.id);

		await expect(store.compareAndSetActive('someone-else', b.id)).resolves.toBe(false);
		expect(await store.getActiveId()).toBe(a.id);
		await expect(store.compareAndSetActive(a.id, b.id)).resolves.toBe(true);
		expect(await store.getActiveId()).toBe(b.id);
		await expect(store.compareAndSetActive(b.id, null)).resolves.toBe(true);
		expect(await store.getActiveId()).toBeNull();
	});

	test('compareAndSetActive() rejects a missing target without changing the selection', async () => {
		const { store } = freshStore();
		const active = await store.add(guardianInput({ id: 'active' }));
		await store.setActive(active.id);

		await expect(store.compareAndSetActive(active.id, 'missing')).rejects.toThrow(
			/Unknown connection/
		);
		expect(await store.getActiveId()).toBe(active.id);
	});

	test('removal started before activation cannot leave a dangling active id', async () => {
		const { store } = freshStore();
		const target = await store.add(guardianInput({ id: 'race-target' }));

		const removal = store.remove(target.id);
		const activation = store.setActive(target.id);
		await Promise.allSettled([removal, activation]);

		expect(await store.get(target.id)).toBeNull();
		expect(await store.getActiveId()).toBeNull();
		expect(await store.getActive()).toBeNull();
	});

  test('removing the active entry clears the selection (no dangling active id)', async () => {
    const { store } = freshStore();
    const a = await store.add(guardianInput());
    await store.setActive(a.id);
    await store.remove(a.id);
    expect(await store.getActiveId()).toBeNull();
    expect(await store.getActive()).toBeNull();
  });

  test('entries and the active selection persist in the storage backend, not the store instance', async () => {
    const storage = createMemoryStorage();
    const first = createConnectionStore({ storage });
    const added = await first.add(guardianInput({ id: 'conn-persist' }));
    await first.setActive(added.id);

    const second = createConnectionStore({ storage });
    expect(await second.list()).toEqual([added]);
    expect(await second.getActiveId()).toBe('conn-persist');
    expect(await second.getActive()).toEqual(added);
  });
});

describe('last session cursor', () => {
  test('persists only browser-owned session ids in the existing meta storage', async () => {
    const storage = createMemoryStorage();
    const first = createConnectionStore({ storage });
    await first.add(guardianInput({ id: 'conn-persist' }));

    expect(await first.getLastSessionId('conn-persist')).toBeNull();
    await first.setLastSessionId('conn-persist', 'session-1');

    const second = createConnectionStore({ storage });
    expect(await second.getLastSessionId('conn-persist')).toBe('session-1');
    expect(await storage.getMeta('lastSession:conn-persist')).toBe('session-1');

    await second.setLastSessionId('conn-persist', null);
    expect(await second.getLastSessionId('conn-persist')).toBeNull();
  });

  test('rejects a non-null cursor for an unknown connection without writing meta', async () => {
    const { storage, store } = freshStore();

    await expect(store.setLastSessionId('missing', 'session-1')).rejects.toThrow(
      /Unknown connection/
    );
    expect(await storage.getMeta('lastSession:missing')).toBeNull();
    await expect(store.setLastSessionId('missing', null)).resolves.toBeUndefined();
  });

  test('removing a connection clears its last-session cursor', async () => {
    const { store } = freshStore();
    const added = await store.add(guardianInput({ id: 'conn-remove' }));
    await store.setLastSessionId(added.id, 'session-1');

    await store.remove(added.id);

    expect(await store.getLastSessionId(added.id)).toBeNull();
  });

  test('runtime-config pruning clears the removed connection cursor', async () => {
    const { store } = freshStore();
    const removed = seededEntry({ id: 'seed-removed', isDefault: false });
    await store.seedFromRuntimeConfig({ connections: [removed] });
    await store.setLastSessionId(removed.id, 'session-1');

    await store.seedFromRuntimeConfig({ connections: [] });

    expect(await store.getLastSessionId(removed.id)).toBeNull();
  });
});

describe('loadRuntimeConfig', () => {
  test("prefers the process-scoped '/api/runtime-config' endpoint", async () => {
    const config: RuntimeConfig = { connections: [seededEntry()] };
    const { fetch, calls } = recordingFetch(() => jsonResponse(config));
    const loaded = await loadRuntimeConfig(fetch);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('/api/runtime-config');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].credentials).toBe('omit');
    expect(calls[0].cache).toBe('no-store');
    expect(loaded).toEqual(config);
  });

  test('falls back to the static assistant config only when the process endpoint is absent', async () => {
    const config: RuntimeConfig = { connections: [seededEntry()] };
    const { fetch, calls } = recordingFetch((url) => (
      url === '/api/runtime-config'
        ? new Response('not found', { status: 404 })
        : jsonResponse(config)
    ));
    expect(await loadRuntimeConfig(fetch)).toEqual(config);
    expect(calls.map((call) => call.url)).toEqual(['/api/runtime-config', '/runtime-config.json']);
  });

  test('absent process and static config means no default', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('not found', { status: 404 }));
    expect(await loadRuntimeConfig(fetch)).toBeNull();
    expect(calls.map((call) => call.url)).toEqual(['/api/runtime-config', '/runtime-config.json']);
  });

  test('offline (fetch rejects) resolves null, does not throw', async () => {
    expect(await loadRuntimeConfig(rejectingFetch('offline'))).toBeNull();
  });

  test('malformed process JSON resolves null without consulting the static file', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('<html>SPA fallback</html>', { status: 200 }));
    expect(await loadRuntimeConfig(fetch)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('present process JSON with an invalid shape fails closed without static fallback', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse({ unexpected: true }));
    expect(await loadRuntimeConfig(fetch)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('a process endpoint error does not revive a stale static connection', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse({ error: 'invalid_runtime_config' }, 500));
    expect(await loadRuntimeConfig(fetch)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('rewrites locked loopback default URLs to the current LAN browser host', async () => {
    const config: RuntimeConfig = {
      connections: [
        seededEntry({ baseUrl: 'http://127.0.0.1:3800' }),
        seededEntry({ id: 'remote', locked: false, baseUrl: 'http://127.0.0.1:4900' }),
      ],
    };
    const { fetch } = recordingFetch(() => jsonResponse(config));

    const loaded = await withLocationHost('192.168.1.10', () => loadRuntimeConfig(fetch));

    expect(loaded?.connections[0]?.baseUrl).toBe('http://192.168.1.10:3800/');
    expect(loaded?.connections[1]?.baseUrl).toBe('http://127.0.0.1:4900');
  });

  test('keeps locked loopback default URLs unchanged on localhost clients', async () => {
    const config: RuntimeConfig = { connections: [seededEntry({ baseUrl: 'http://127.0.0.1:3800' })] };
    const { fetch } = recordingFetch(() => jsonResponse(config));

    const loaded = await withLocationHost('127.0.0.1', () => loadRuntimeConfig(fetch));

    expect(loaded?.connections[0]?.baseUrl).toBe('http://127.0.0.1:3800');
  });

  test('drops HTTP runtime defaults on a remote HTTPS PWA origin', async () => {
    const config: RuntimeConfig = {
      connections: [
        seededEntry({ baseUrl: 'http://127.0.0.1:3800' }),
        seededEntry({ id: 'secure', baseUrl: 'https://assistant.example' }),
      ],
    };
    const { fetch } = recordingFetch(() => jsonResponse(config));

    const loaded = await withLocationHost('pwa.example', () => loadRuntimeConfig(fetch), 'https:');

    expect(loaded?.connections).toEqual([
      expect.objectContaining({ id: 'secure', baseUrl: 'https://assistant.example' }),
    ]);
  });

  test('keeps a trustworthy loopback HTTP default on an HTTPS localhost origin', async () => {
    const config: RuntimeConfig = {
      connections: [seededEntry({ baseUrl: 'http://127.0.0.1:3800' })],
    };
    const { fetch } = recordingFetch(() => jsonResponse(config));

    const loaded = await withLocationHost('localhost', () => loadRuntimeConfig(fetch), 'https:');

    expect(loaded?.connections[0]?.baseUrl).toBe('http://127.0.0.1:3800');
  });

  test('rejects runtime connection URLs containing userinfo', async () => {
    const config: RuntimeConfig = {
      connections: [seededEntry({ baseUrl: 'http://legacy-user:legacy-password@127.0.0.1:3800' })],
    };
    const { fetch } = recordingFetch(() => jsonResponse(config));

    expect(await loadRuntimeConfig(fetch)).toBeNull();
  });
});

describe('seedFromRuntimeConfig (locked default)', () => {
  test('null config is a no-op', async () => {
    const { store } = freshStore();
    await store.seedFromRuntimeConfig(null);
    expect(await store.list()).toEqual([]);
    expect(await store.getActiveId()).toBeNull();
  });

  test('seeds the config entries under their stable ids', async () => {
    const { store } = freshStore();
    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });
    expect(await store.get('seed-local-opencode')).toEqual(seededEntry());
    expect((await store.list()).length).toBe(1);
  });

  test('a seeded isDefault entry becomes active when nothing is active yet', async () => {
    const { store } = freshStore();
    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });
    expect(await store.getActiveId()).toBe('seed-local-opencode');
    expect((await store.getActive())?.locked).toBe(true);
  });

  test('re-seeding is idempotent and config wins for locked entries (label/baseUrl refresh)', async () => {
    const { store } = freshStore();
    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });
    await store.seedFromRuntimeConfig({
      connections: [seededEntry({ label: 'Renamed by config', baseUrl: 'http://127.0.0.1:5096' })],
    });
    const all = await store.list();
    expect(all.length).toBe(1);
    expect(all[0]).toEqual(seededEntry({ label: 'Renamed by config', baseUrl: 'http://127.0.0.1:5096' }));
  });

  test('re-seeding preserves user-attached credentials on a locked entry', async () => {
    const { store } = freshStore();
    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });
    await store.setSecretRef('seed-local-opencode', { mode: 'basic', username: 'carol', secretRef: 'sec_user' });

    await store.seedFromRuntimeConfig({
      connections: [seededEntry({ label: 'Renamed by config', baseUrl: 'http://127.0.0.1:5096' })],
    });

    const entry = await store.get('seed-local-opencode');
    expect(entry?.auth).toEqual({ mode: 'basic', username: 'carol', secretRef: 'sec_user' });
    expect(entry?.label).toBe('Renamed by config');
    expect(entry?.baseUrl).toBe('http://127.0.0.1:5096');
    expect((await store.list()).length).toBe(1);
  });

  test('seeding never steals an explicit user selection', async () => {
    const { store } = freshStore();
    const mine = await store.add({
      label: 'My remote',
      baseUrl: 'https://gw.example',
      auth: { mode: 'basic', username: 'carol', secretRef: 'sec_1' },
    });
    await store.setActive(mine.id);
    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });
    expect(await store.getActiveId()).toBe(mine.id);
  });

  test('seeding leaves user-added entries untouched', async () => {
    const { store } = freshStore();
    const mine = await store.add({
      id: 'conn-user',
      label: 'My remote',
      baseUrl: 'https://gw.example',
      auth: { mode: 'basic', username: 'dave', secretRef: 'sec_2' },
    });
    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });
    expect(await store.get('conn-user')).toEqual(mine);
    expect((await store.list()).length).toBe(2);
  });

  test('does not seed a duplicate for an existing loopback alias on the same port', async () => {
    const { store } = freshStore();
    const existing = await store.add({
      id: 'existing-local',
      label: 'My assistant',
      baseUrl: 'http://localhost:4096/oc',
      auth: { mode: 'basic', username: 'carol', secretRef: 'sec_local' },
    });

    await store.seedFromRuntimeConfig({
      connections: [seededEntry({ label: 'splinter' })],
    });

    expect(await store.list()).toEqual([existing]);
    expect(await store.getActiveId()).toBe(existing.id);
  });

  test('keeps connections to different loopback ports distinct', async () => {
    const { store } = freshStore();
    const existing = await store.add({
      id: 'other-local',
      label: 'Other local service',
      baseUrl: 'http://localhost:4900',
      auth: { mode: 'none' },
    });

    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });

    expect(await store.list()).toEqual([existing, seededEntry()]);
  });

  test('cleans up a persisted locked duplicate and migrates a legacy discovered label', async () => {
    const { storage, store } = freshStore();
    const discovered = await store.add({
      id: 'discovered-local',
      label: 'Local assistant',
      baseUrl: 'http://127.0.0.1:4096',
      auth: { mode: 'basic', username: 'carol', secretRef: 'sec_local' },
    });
    await storage.put(seededEntry({ baseUrl: 'http://localhost:4096' }));
    await store.setActive('seed-local-opencode');

    await store.seedFromRuntimeConfig({
      connections: [seededEntry({ label: 'splinter', baseUrl: 'http://localhost:4096' })],
    });

    expect(await store.list()).toEqual([{ ...discovered, label: 'splinter' }]);
    expect(await store.getActiveId()).toBe(discovered.id);
  });

  test('re-seeding prunes locked entries that disappeared from runtime-config.json', async () => {
    const { store } = freshStore();
    await store.seedFromRuntimeConfig({
      connections: [seededEntry(), seededEntry({ id: 'seed-removed', label: 'Old lock' })],
    });

    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });

    expect(await store.get('seed-local-opencode')).toEqual(seededEntry());
    expect(await store.get('seed-removed')).toBeNull();
    expect(await store.list()).toEqual([seededEntry()]);
  });

  test('re-seeding prunes a removed locked active entry and clears the active selection', async () => {
    const { store } = freshStore();
    const removed = seededEntry({ id: 'seed-removed', label: 'Old lock', isDefault: false });
    await store.seedFromRuntimeConfig({ connections: [removed] });
    await store.setActive(removed.id);

    await store.seedFromRuntimeConfig({ connections: [seededEntry({ isDefault: false })] });

    expect(await store.get(removed.id)).toBeNull();
    expect(await store.getActiveId()).toBeNull();
  });

  test('seeded locked entries stay immutable through the store API', async () => {
    const { store } = freshStore();
    await store.seedFromRuntimeConfig({ connections: [seededEntry()] });
    await expect(store.update('seed-local-opencode', { baseUrl: 'http://evil.example' })).rejects.toThrow();
    await expect(store.remove('seed-local-opencode')).rejects.toThrow();
    expect((await store.get('seed-local-opencode'))?.baseUrl).toBe('http://127.0.0.1:4096');
  });
});

describe('offline read path', () => {
  test('offline boot: loadRuntimeConfig -> null, seed(null) no-op, stored connections still readable', async () => {
    const storage = createMemoryStorage();
    const online = createConnectionStore({ storage });
    await online.seedFromRuntimeConfig({ connections: [seededEntry()] });
    const mine = await online.add({
      id: 'conn-user',
      label: 'My remote',
      baseUrl: 'https://gw.example',
      auth: { mode: 'basic', username: 'carol', secretRef: 'sec_1' },
    });

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

describe('locked baseUrl resolution — the same-origin /oc seed', () => {
  function runtimeConfigFetch(baseUrl: string): typeof globalThis.fetch {
    return (async () =>
      new Response(
        JSON.stringify({
          connections: [
            {
              id: 'openpalm-assistant-opencode',
              label: 'Local assistant',
              baseUrl,
              auth: { mode: 'none' },
              isDefault: true,
              locked: true,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch;
  }

  test('resolves a root-relative seed against whatever origin the browser loaded', async () => {
    // The container writes "/oc" at startup and cannot know the origin a phone
    // will later visit — this is the whole reason the seed is relative.
    const loaded = await withLocationHost('openpalm.local', () =>
      loadRuntimeConfig(runtimeConfigFetch('/oc')),
    );
    expect(loaded?.connections[0]?.baseUrl).toBe('http://openpalm.local/oc');
  });

  test('resolves the same seed to loopback when opened on the desktop', async () => {
    const loaded = await withLocationHost('localhost', () =>
      loadRuntimeConfig(runtimeConfigFetch('/oc')),
    );
    expect(loaded?.connections[0]?.baseUrl).toBe('http://localhost/oc');
  });

  test('carries the scheme through, so an HTTPS origin yields an HTTPS target', async () => {
    const loaded = await withLocationHost(
      'palm.example.com',
      () => loadRuntimeConfig(runtimeConfigFetch('/oc')),
      'https:',
    );
    expect(loaded?.connections[0]?.baseUrl).toBe('https://palm.example.com/oc');
  });

  test('still rewrites a legacy absolute loopback seed, so a pre-proxy install keeps working', async () => {
    const loaded = await withLocationHost('192.168.1.10', () =>
      loadRuntimeConfig(runtimeConfigFetch('http://127.0.0.1:3810')),
    );
    expect(loaded?.connections[0]?.baseUrl).toBe('http://192.168.1.10:3810/');
  });
});
