/**
 * E7 [LOW] (review 2026-07-10 §E7) — connection passwords/tokens were
 * stored as PLAINTEXT JSON in the same storage backend as everything else
 * (IndexedDB in the browser): any same-origin script could read
 * `secret:<ref>` and get the raw password/token back with zero effort.
 *
 * Fix pinned here: `createSecretStore` now wraps material with WebCrypto
 * AES-GCM before it ever reaches `storage.setMeta` — a non-extractable key
 * lives in the storage backend's own structured-clone area
 * (`getCryptoKey`/`setCryptoKey`, since `getMeta`/`setMeta` are JSON strings
 * and can't carry a CryptoKey), generated once and reused. Existing
 * plaintext records (written before this fix shipped) still decode via
 * `resolveAuth`/`peekUsername` and are transparently re-encrypted in place
 * (lazy migration) — an old install upgrades silently on first read.
 *
 * E9's username-only edit path also lives here: `peekUsername` exposes ONLY
 * the non-secret half (never the password/token, so the edit form can show
 * a stored username without ever re-displaying — or requiring a retype of —
 * the secret), and `updateUsername` rewrites just that half, preserving
 * whatever password/token is already stored.
 *
 * RED until src/lib/connections/secrets.ts implements encryption: the
 * "ciphertext is not plaintext" and "getCryptoKey returns a non-extractable
 * key" assertions fail against the pre-fix plaintext-JSON implementation,
 * and peekUsername/updateUsername don't exist yet.
 */
import { describe, expect, test } from 'bun:test';

async function loadModules() {
  const connections = await import('../src/lib/connections/index.ts');
  const secrets = await import('../src/lib/connections/secrets.ts');
  return { ...connections, ...secrets };
}

function basicEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    label: 'Home guardian',
    kind: 'remote-opencode' as const,
    url: 'http://gw.example:8443',
    auth: { mode: 'basic' as const, secretRef: 'sec_1' },
    ...overrides,
  };
}

function bearerEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-2',
    label: 'Remote token',
    kind: 'remote-opencode' as const,
    url: 'http://gw.example:9443',
    auth: { mode: 'bearer' as const, secretRef: 'sec_2' },
    ...overrides,
  };
}

describe('createSecretStore encryption (E7)', () => {
  test('set()/resolveAuth() round-trips Basic username+password', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.set('sec_1', { username: 'carol', password: 'hunter2' });
    expect(await store.resolveAuth(basicEntry())).toEqual({
      mode: 'basic',
      username: 'carol',
      password: 'hunter2',
    });
  });

  test('set()/resolveAuth() round-trips a Bearer token', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.set('sec_2', { token: 'tok_abc' });
    expect(await store.resolveAuth(bearerEntry())).toEqual({ mode: 'bearer', token: 'tok_abc' });
  });

  test('the RAW stored record is not plaintext JSON containing the password (the actual E7 regression)', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.set('sec_1', { username: 'carol', password: 'hunter2-secret' });
    const raw = await storage.getMeta('secret:sec_1');
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('hunter2-secret');
    expect(raw).not.toContain('carol');
    // Still a small JSON envelope (iv + ciphertext), not opaque binary glued
    // into an arbitrary shape — keeps the storage format inspectable/stable.
    expect(() => JSON.parse(raw as string)).not.toThrow();
  });

  test('the AES-GCM key persisted via storage.getCryptoKey() is non-extractable', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.set('sec_1', { password: 'x' });
    const key = await storage.getCryptoKey();
    expect(key).not.toBeNull();
    expect((key as CryptoKey).extractable).toBe(false);
    expect((key as CryptoKey).algorithm.name).toBe('AES-GCM');
  });

  test('the same key is reused across multiple set() calls (not regenerated each time)', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.set('sec_1', { password: 'a' });
    const first = await storage.getCryptoKey();
    await store.set('sec_2', { token: 'b' });
    const second = await storage.getCryptoKey();
    expect(second).toBe(first);
  });

  test('delete() clears the secret and resolveAuth degrades to none', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.set('sec_1', { username: 'carol', password: 'hunter2' });
    await store.delete('sec_1');
    expect(await storage.getMeta('secret:sec_1')).toBeNull();
    expect(await store.resolveAuth(basicEntry())).toEqual({ mode: 'none' });
  });

  test('a missing secretRef degrades to none rather than throwing', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    expect(await store.resolveAuth(basicEntry())).toEqual({ mode: 'none' });
  });

  test('a corrupted/unrecognizable stored record degrades to none rather than throwing', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await storage.setMeta('secret:sec_1', 'not even json{');
    expect(await store.resolveAuth(basicEntry())).toEqual({ mode: 'none' });
  });

  test('lazy migration: a legacy PLAINTEXT record (pre-E7 install) still resolves correctly', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    // Simulate an existing installation's on-disk record from before the E7
    // fix shipped: raw plaintext JSON, no envelope.
    await storage.setMeta('secret:sec_1', JSON.stringify({ username: 'carol', password: 'hunter2' }));
    const store = createSecretStore(storage);
    expect(await store.resolveAuth(basicEntry())).toEqual({
      mode: 'basic',
      username: 'carol',
      password: 'hunter2',
    });
  });

  test('lazy migration: reading a legacy plaintext record re-encrypts it in place', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    const legacyRaw = JSON.stringify({ password: 'hunter2' });
    await storage.setMeta('secret:sec_1', legacyRaw);
    const store = createSecretStore(storage);
    await store.resolveAuth(basicEntry());
    const rewritten = await storage.getMeta('secret:sec_1');
    expect(rewritten).not.toBe(legacyRaw);
    expect(rewritten).not.toContain('hunter2');
    // And it still resolves correctly on a second read (round-trips through
    // the new encrypted form, not just a one-time pass-through).
    expect(await store.resolveAuth(basicEntry())).toEqual({ mode: 'basic', password: 'hunter2' });
  });
});

describe('concurrent key generation (F2 — lockless getOrCreateKey check-then-act race)', () => {
  // F2 (independent-verifier review of PR #562): getOrCreateKey() reads
  // storage.getCryptoKey(), and if absent, generates a new key and persists
  // it — with an `await` between the read and the write. probeAll() on the
  // connections page fires resolveAuth() for every connection in a single
  // Promise.all; on a pre-E7 install every entry lazily migrates via
  // writeMaterial -> getOrCreateKey CONCURRENTLY. Without serialization,
  // every concurrent first-time caller sees "no key yet", each generates a
  // DIFFERENT key, and the last storage.setCryptoKey() call wins — every
  // record encrypted under a losing key becomes permanently undecryptable.
  //
  // This wrapper widens the real race window (storage.getCryptoKey()/
  // setCryptoKey() are effectively instant in the in-memory backend, and
  // crypto.subtle.generateKey() resolves purely through microtasks here —
  // a SINGLE delayed hop isn't enough: it just serializes the callers one
  // at a time instead of interleaving them, since the first caller's
  // whole read->generate->persist chain finishes via microtasks before
  // the next caller's read timer even fires). Delaying BOTH getCryptoKey
  // AND setCryptoKey (macrotask hops on both sides of the generate step)
  // forces every caller past its OWN "no key yet" read before any of them
  // reaches "persist the key I generated" — the actual concurrent-writers
  // shape of the real bug (many probeAll() callers racing through
  // writeMaterial() at once).
  function delayedStorage(base: ReturnType<typeof import('../src/lib/connections/index.ts').createMemoryStorage>) {
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

  function entryFor(ref: string) {
    return {
      id: 'conn-race',
      label: 'Race target',
      kind: 'remote-opencode' as const,
      url: 'http://gw.example:8443',
      auth: { mode: 'basic' as const, secretRef: ref },
    };
  }

  test('many concurrent first-time getOrCreateKey callers resolve to ONE key, and every record written concurrently still decrypts afterward', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const base = createMemoryStorage();
    const storage = delayedStorage(base);
    const store = createSecretStore(storage);

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

describe('peekUsername / updateUsername (E9 — edit form must not lose/revert the username)', () => {
  test('peekUsername returns the stored username without exposing the password', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.set('sec_1', { username: 'carol', password: 'hunter2' });
    expect(await store.peekUsername('sec_1')).toBe('carol');
  });

  test('peekUsername returns undefined when no username is stored (default-username case)', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.set('sec_1', { password: 'hunter2' });
    expect(await store.peekUsername('sec_1')).toBeUndefined();
  });

  test('peekUsername returns undefined for an unknown ref', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    expect(await store.peekUsername('missing')).toBeUndefined();
  });

  test('updateUsername rewrites only the username half, preserving the stored password', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.set('sec_1', { username: 'carol', password: 'hunter2' });
    await store.updateUsername('sec_1', 'dave');
    expect(await store.resolveAuth(basicEntry())).toEqual({
      mode: 'basic',
      username: 'dave',
      password: 'hunter2',
    });
  });

  test('updateUsername(ref, undefined) clears the username, falling back to the default (no username field stored)', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.set('sec_1', { username: 'carol', password: 'hunter2' });
    await store.updateUsername('sec_1', undefined);
    expect(await store.resolveAuth(basicEntry())).toEqual({ mode: 'basic', password: 'hunter2' });
  });

  test('updateUsername on an unknown ref is a no-op (nothing to merge into)', async () => {
    const { createMemoryStorage, createSecretStore } = await loadModules();
    const storage = createMemoryStorage();
    const store = createSecretStore(storage);
    await store.updateUsername('missing', 'dave');
    expect(await storage.getMeta('secret:missing')).toBeNull();
  });
});
