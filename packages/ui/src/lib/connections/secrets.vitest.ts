/**
 * Encrypted credential store: createSecretStore wraps material with WebCrypto
 * AES-GCM before it ever reaches storage.setMeta, using a non-extractable key
 * persisted in the storage backend's structured-clone area. Legacy plaintext
 * records still decode and are transparently re-encrypted in place.
 *
 * Covers the none | basic auth model and the ui Connection shape (baseUrl,
 * username inline on the entry). Uses createMemoryStorage() — no real IndexedDB
 * needed.
 */
import { describe, expect, test } from 'vitest';
import { createMemoryStorage, type Connection, type ConnectionStorage } from './store.js';
import { createSecretStore } from './secrets.js';

function basicEntry(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    label: 'Home guardian',
    baseUrl: 'http://gw.example:8443',
    auth: { mode: 'basic', username: 'carol', secretRef: 'sec_1' },
    ...overrides,
  };
}

describe('createSecretStore encryption', () => {
  test('set()/resolveAuth() round-trips Basic username+password', async () => {
    const store = createSecretStore(createMemoryStorage());
    await store.set('sec_1', { username: 'carol', password: 'hunter2' });
    expect(await store.resolveAuth(basicEntry())).toEqual({
      mode: 'basic',
      username: 'carol',
      password: 'hunter2',
    });
  });

  test('the RAW stored record is not plaintext JSON containing the password', async () => {
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.set('sec_1', { username: 'carol', password: 'hunter2-secret' });
    const raw = await storage.getMeta('secret:sec_1');
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('hunter2-secret');
    expect(raw).not.toContain('carol');
    // Still a small JSON envelope (iv + ciphertext), not opaque binary.
    expect(() => JSON.parse(raw as string)).not.toThrow();
  });

  test('the AES-GCM key persisted via storage.getCryptoKey() is non-extractable', async () => {
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.set('sec_1', { password: 'x' });
    const key = await storage.getCryptoKey();
    expect(key).not.toBeNull();
    expect((key as CryptoKey).extractable).toBe(false);
    expect((key as CryptoKey).algorithm.name).toBe('AES-GCM');
  });

  test('the same key is reused across multiple set() calls (not regenerated each time)', async () => {
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.set('sec_1', { password: 'a' });
    const first = await storage.getCryptoKey();
    await store.set('sec_2', { password: 'b' });
    const second = await storage.getCryptoKey();
    expect(second).toBe(first);
  });

  test('delete() clears the secret and resolveAuth degrades to none', async () => {
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.set('sec_1', { username: 'carol', password: 'hunter2' });
    await store.delete('sec_1');
    expect(await storage.getMeta('secret:sec_1')).toBeNull();
    expect(await store.resolveAuth(basicEntry())).toEqual({ mode: 'none' });
  });

  test('a missing secretRef degrades to none rather than throwing', async () => {
    const store = createSecretStore(createMemoryStorage());
    expect(await store.resolveAuth(basicEntry())).toEqual({ mode: 'none' });
  });

  test('a corrupted/unrecognizable stored record degrades to none rather than throwing', async () => {
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await storage.setMeta('secret:sec_1', 'not even json{');
    expect(await store.resolveAuth(basicEntry())).toEqual({ mode: 'none' });
  });

  test('a none-mode entry resolves to none without touching storage', async () => {
    const store = createSecretStore(createMemoryStorage());
    expect(await store.resolveAuth(basicEntry({ auth: { mode: 'none' } }))).toEqual({ mode: 'none' });
  });

  test('lazy migration: a legacy PLAINTEXT record still resolves correctly', async () => {
    const storage = createMemoryStorage();
    // Simulate an on-disk record from before encryption shipped: raw plaintext
    // JSON, no envelope.
    await storage.setMeta('secret:sec_1', JSON.stringify({ username: 'carol', password: 'hunter2' }));
    const store = createSecretStore(storage);
    expect(await store.resolveAuth(basicEntry())).toEqual({
      mode: 'basic',
      username: 'carol',
      password: 'hunter2',
    });
  });

  test('lazy migration: reading a legacy plaintext record re-encrypts it in place', async () => {
    const storage = createMemoryStorage();
    const legacyRaw = JSON.stringify({ password: 'hunter2' });
    await storage.setMeta('secret:sec_1', legacyRaw);
    const store = createSecretStore(storage);
    // Entry with no inline username so the resolved auth mirrors the material.
    const entry = basicEntry({ auth: { mode: 'basic', username: '', secretRef: 'sec_1' } });
    await store.resolveAuth(entry);
    const rewritten = await storage.getMeta('secret:sec_1');
    expect(rewritten).not.toBe(legacyRaw);
    expect(rewritten).not.toContain('hunter2');
    // And it still resolves correctly on a second read.
    expect(await store.resolveAuth(entry)).toEqual({ mode: 'basic', password: 'hunter2' });
  });
});

describe('concurrent key generation (lockless getOrCreateKey check-then-act race)', () => {
  // Delaying BOTH getCryptoKey AND setCryptoKey (macrotask hops on both sides
  // of the generate step) forces every caller past its OWN "no key yet" read
  // before any of them reaches "persist the key I generated" — the actual
  // concurrent-writers shape of the real bug.
  function delayedStorage(base: ConnectionStorage): ConnectionStorage {
    return {
      ...base,
      async getCryptoKey() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return base.getCryptoKey();
      },
      async setCryptoKey(key: CryptoKey) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return base.setCryptoKey(key);
      },
    };
  }

  function entryFor(ref: string): Connection {
    return {
      id: 'conn-race',
      label: 'Race target',
      baseUrl: 'http://gw.example:8443',
      auth: { mode: 'basic', username: '', secretRef: ref },
    };
  }

  test('many concurrent first-time callers resolve to ONE key, and every record still decrypts', async () => {
    const store = createSecretStore(delayedStorage(createMemoryStorage()));
    const refs = ['sec_1', 'sec_2', 'sec_3', 'sec_4', 'sec_5'] as const;
    await Promise.all(refs.map((ref, i) => store.set(ref, { password: `pass-${i}` })));

    for (const [i, ref] of refs.entries()) {
      expect(await store.resolveAuth(entryFor(ref))).toEqual({
        mode: 'basic',
        password: `pass-${i}`,
      });
    }
  });
});

describe('updateUsername (edit form must not lose/revert the username)', () => {
  function refEntry(): Connection {
    return {
      id: 'conn-1',
      label: 'Home guardian',
      baseUrl: 'http://gw.example:8443',
      auth: { mode: 'basic', username: '', secretRef: 'sec_1' },
    };
  }

  test('updateUsername rewrites only the username half, preserving the stored password', async () => {
    const store = createSecretStore(createMemoryStorage());
    await store.set('sec_1', { username: 'carol', password: 'hunter2' });
    await store.updateUsername('sec_1', 'dave');
    expect(await store.resolveAuth(refEntry())).toEqual({
      mode: 'basic',
      username: 'dave',
      password: 'hunter2',
    });
  });

  test('updateUsername(ref, undefined) clears the username, falling back to the default', async () => {
    const store = createSecretStore(createMemoryStorage());
    await store.set('sec_1', { username: 'carol', password: 'hunter2' });
    await store.updateUsername('sec_1', undefined);
    expect(await store.resolveAuth(refEntry())).toEqual({ mode: 'basic', password: 'hunter2' });
  });

  test('updateUsername on an unknown ref is a no-op (nothing to merge into)', async () => {
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.updateUsername('missing', 'dave');
    expect(await storage.getMeta('secret:missing')).toBeNull();
  });
});
