/**
 * Localhost assistant auto-discovery: probes the well-known local endpoints,
 * adds the first reachable one as an unlocked connection, dedupes against any
 * existing loopback entry, and honors the user's dismissal.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createConnectionStore, createMemoryStorage } from './store.js';
import {
  discoverLocalAssistant,
  isDiscoveryCandidateUrl,
  isLocalDiscoveryDismissed,
  LOCAL_DISCOVERY_CANDIDATES,
  markLocalDiscoveryDismissed,
} from './discovery.js';

function freshStore() {
  return createConnectionStore({ storage: createMemoryStorage() });
}

function fetchRespondingTo(urls: Record<string, number>): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [prefix, status] of Object.entries(urls)) {
      if (url.startsWith(prefix)) return new Response('', { status });
    }
    throw new TypeError('fetch failed');
  }) as typeof globalThis.fetch;
}

const fetchNothing = (async () => {
  throw new TypeError('fetch failed');
}) as unknown as typeof globalThis.fetch;

// The server test project runs in plain Node (no localStorage); the module
// reads globalThis.localStorage per call, so a minimal in-memory shim works.
beforeEach(() => {
  const backing = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, String(value)),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
  };
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('discoverLocalAssistant', () => {
  test('adds the direct assistant when it responds', async () => {
    const store = freshStore();
    const added = await discoverLocalAssistant(
      store,
      fetchRespondingTo({ 'http://127.0.0.1:3810': 200 })
    );
    expect(added).not.toBeNull();
    expect(added?.baseUrl).toBe('http://127.0.0.1:3810');
    expect(added?.label).toBe('Local assistant');
    expect(added?.locked).toBeUndefined();
    expect(await store.list()).toHaveLength(1);
  });

  test('falls back to the guardian front door and treats 401 as present', async () => {
    const store = freshStore();
    const added = await discoverLocalAssistant(
      store,
      fetchRespondingTo({ 'http://127.0.0.1:3830/oc': 401 })
    );
    expect(added?.baseUrl).toBe('http://127.0.0.1:3830/oc');
  });

  test('a 404 on the port is NOT an assistant', async () => {
    const store = freshStore();
    const added = await discoverLocalAssistant(
      store,
      fetchRespondingTo({ 'http://127.0.0.1:3810': 404, 'http://127.0.0.1:3830/oc': 500 })
    );
    expect(added).toBeNull();
    expect(await store.list()).toHaveLength(0);
  });

  test('adds nothing when nothing is listening', async () => {
    const store = freshStore();
    expect(await discoverLocalAssistant(store, fetchNothing)).toBeNull();
    expect(await store.list()).toHaveLength(0);
  });

  test('skips discovery when the same loopback port already exists under another spelling', async () => {
    const store = freshStore();
    await store.add({
      label: 'Seeded default',
      baseUrl: 'http://localhost:3810',
      auth: { mode: 'none' },
      locked: true,
    });
    const added = await discoverLocalAssistant(
      store,
      fetchRespondingTo({ 'http://127.0.0.1:3810': 200 })
    );
    expect(added).toBeNull();
    expect(await store.list()).toHaveLength(1);
  });

  test('does not let a connection on another loopback port suppress discovery', async () => {
    const store = freshStore();
    await store.add({
      label: 'Another local service',
      baseUrl: 'http://localhost:4900',
      auth: { mode: 'none' },
    });
    const added = await discoverLocalAssistant(
      store,
      fetchRespondingTo({ 'http://127.0.0.1:3810': 200 })
    );
    expect(added?.baseUrl).toBe('http://127.0.0.1:3810');
    expect(await store.list()).toHaveLength(2);
  });

  test('does not skip for remote-only connections', async () => {
    const store = freshStore();
    await store.add({
      label: 'Remote',
      baseUrl: 'https://gw.example.ts.net/oc',
      auth: { mode: 'none' },
    });
    const added = await discoverLocalAssistant(
      store,
      fetchRespondingTo({ 'http://127.0.0.1:3810': 200 })
    );
    expect(added?.baseUrl).toBe('http://127.0.0.1:3810');
  });

  test('respects the dismissal flag', async () => {
    markLocalDiscoveryDismissed();
    expect(isLocalDiscoveryDismissed()).toBe(true);
    const store = freshStore();
    const added = await discoverLocalAssistant(
      store,
      fetchRespondingTo({ 'http://127.0.0.1:3810': 200 })
    );
    expect(added).toBeNull();
  });
});

describe('isDiscoveryCandidateUrl', () => {
  test('matches candidates across spellings', () => {
    for (const candidate of LOCAL_DISCOVERY_CANDIDATES) {
      expect(isDiscoveryCandidateUrl(candidate.baseUrl)).toBe(true);
    }
    expect(isDiscoveryCandidateUrl('http://localhost:3810')).toBe(true);
    expect(isDiscoveryCandidateUrl('http://127.0.0.1:3810/')).toBe(true);
    expect(isDiscoveryCandidateUrl('http://127.0.0.1:3830/oc/')).toBe(true);
  });

  test('rejects non-candidates', () => {
    expect(isDiscoveryCandidateUrl('http://10.0.0.5:3800')).toBe(false);
    expect(isDiscoveryCandidateUrl('http://127.0.0.1:9999')).toBe(false);
    expect(isDiscoveryCandidateUrl('not a url')).toBe(false);
  });
});
