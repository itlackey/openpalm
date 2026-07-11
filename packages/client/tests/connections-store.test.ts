/**
 * P5b (#555) RED — connection store CRUD + active selection (P5b item 2,
 * plan §6.6: ConnectionEntry persisted behind a storage abstraction —
 * IndexedDB in the browser, the in-memory backend here; the tests are the
 * spec for BOTH backends, so everything is async and nothing may live only
 * in store-instance fields).
 *
 * Contract pinned here:
 *   - add() persists a ConnectionEntry, generating an id when the input has
 *     none (explicit ids are kept — runtime-config seeds rely on that),
 *   - update()/remove() reject for unknown ids AND for locked entries
 *     (locked = owned by runtime-config.json, plan §6.6 `locked`),
 *   - active selection is persisted in the same storage (survives a new
 *     store instance over the same backend — the IndexedDB equivalence),
 *   - setActive() rejects unknown ids; removing the active entry clears the
 *     selection (no dangling active id),
 *   - nothing is implicitly activated by add() — only runtime-config
 *     seeding auto-selects a default (see connections-seed.test.ts).
 *
 * RED until src/lib/connections/index.ts exists: every test fails with
 * "Cannot find module …/src/lib/connections/index.ts" (missing feature).
 */
import { describe, expect, test } from 'bun:test';
import { loadConnectionsModule, type NewConnectionInput } from './helpers/contract.ts';

function guardianInput(overrides: Partial<NewConnectionInput> = {}): NewConnectionInput {
  return {
    label: 'Home guardian',
    kind: 'remote-opencode',
    url: 'http://gw.example:8443',
    auth: { mode: 'basic', secretRef: 'sec_1' },
    ...overrides
  };
}

async function freshStore() {
  const { createMemoryStorage, createConnectionStore } = await loadConnectionsModule();
  const storage = createMemoryStorage();
  return { storage, store: createConnectionStore({ storage }) };
}

describe('connection store CRUD (P5b item 2)', () => {
  test('starts empty: list() is [] and get() of an unknown id is null', async () => {
    const { store } = await freshStore();
    expect(await store.list()).toEqual([]);
    expect(await store.get('missing')).toBeNull();
  });

  test('add() returns the stored entry with a generated non-empty id and get() round-trips it', async () => {
    const { store } = await freshStore();
    const added = await store.add(guardianInput());
    expect(typeof added.id).toBe('string');
    expect(added.id.length).toBeGreaterThan(0);
    expect(added).toMatchObject(guardianInput());
    expect(await store.get(added.id)).toEqual(added);
    expect(await store.list()).toEqual([added]);
  });

  test('add() generates distinct ids for successive entries', async () => {
    const { store } = await freshStore();
    const first = await store.add(guardianInput({ label: 'One' }));
    const second = await store.add(guardianInput({ label: 'Two' }));
    expect(second.id).not.toBe(first.id);
    expect((await store.list()).length).toBe(2);
  });

  test('add() keeps an explicit id (runtime-config seeds depend on stable ids)', async () => {
    const { store } = await freshStore();
    const added = await store.add(guardianInput({ id: 'conn-explicit' }));
    expect(added.id).toBe('conn-explicit');
    expect(await store.get('conn-explicit')).toEqual(added);
  });

  test('update() patches fields, persists the result, and returns the updated entry', async () => {
    const { store } = await freshStore();
    const added = await store.add(guardianInput());
    const updated = await store.update(added.id, {
      label: 'Renamed',
      url: 'https://gw.example:9443'
    });
    expect(updated).toEqual({ ...added, label: 'Renamed', url: 'https://gw.example:9443' });
    expect(await store.get(added.id)).toEqual(updated);
  });

  test('update() rejects for an unknown id', async () => {
    const { store } = await freshStore();
    expect(store.update('missing', { label: 'x' })).rejects.toThrow();
  });

  test('update() rejects for a locked entry (config-owned, plan §6.6)', async () => {
    const { store } = await freshStore();
    const locked = await store.add(guardianInput({ id: 'conn-locked', locked: true }));
    expect(store.update(locked.id, { label: 'tampered' })).rejects.toThrow();
    expect((await store.get(locked.id))?.label).toBe('Home guardian');
  });

  test('remove() deletes the entry', async () => {
    const { store } = await freshStore();
    const added = await store.add(guardianInput());
    await store.remove(added.id);
    expect(await store.get(added.id)).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  test('remove() rejects for an unknown id', async () => {
    const { store } = await freshStore();
    expect(store.remove('missing')).rejects.toThrow();
  });

  test('remove() rejects for a locked entry and keeps it stored', async () => {
    const { store } = await freshStore();
    const locked = await store.add(guardianInput({ id: 'conn-locked', locked: true }));
    expect(store.remove(locked.id)).rejects.toThrow();
    expect(await store.get(locked.id)).not.toBeNull();
  });
});

describe('setSecretRef (E6, review 2026-07-10 — locked entries can still receive credentials)', () => {
  // Locked/config-owned entries (e.g. a seeded auth-fronted default assistant
  // URL) previously could never carry credentials at all: update()/remove()
  // reject for locked entries and the UI only offered Edit/Remove behind
  // `!conn.locked`. setSecretRef() is a narrow path that bypasses ONLY the
  // locked check, and ONLY for `auth` — url/label/kind/locked stay immutable
  // even when called on a locked entry (the store, not the UI, is the
  // enforcement point).
  test('attaches auth to a locked entry, touching nothing else', async () => {
    const { store } = await freshStore();
    const locked = await store.add(
      guardianInput({ id: 'conn-locked', locked: true, url: 'http://default.example', auth: { mode: 'none' } })
    );
    const updated = await store.setSecretRef(locked.id, { mode: 'basic', secretRef: 'sec_locked' });
    expect(updated.auth).toEqual({ mode: 'basic', secretRef: 'sec_locked' });
    expect(updated.url).toBe('http://default.example');
    expect(updated.locked).toBe(true);
    expect(updated.label).toBe('Home guardian');
    expect(await store.get(locked.id)).toEqual(updated);
  });

  test('clears auth back to none on a locked entry', async () => {
    const { store } = await freshStore();
    const locked = await store.add(
      guardianInput({ id: 'conn-locked', locked: true, auth: { mode: 'basic', secretRef: 'sec_locked' } })
    );
    const updated = await store.setSecretRef(locked.id, { mode: 'none' });
    expect(updated.auth).toEqual({ mode: 'none' });
    expect(updated.locked).toBe(true);
  });

  test('works identically on unlocked entries (not a locked-only special case)', async () => {
    const { store } = await freshStore();
    const added = await store.add(guardianInput());
    const updated = await store.setSecretRef(added.id, { mode: 'bearer', secretRef: 'tok_1' });
    expect(updated.auth).toEqual({ mode: 'bearer', secretRef: 'tok_1' });
  });

  test('rejects for an unknown id', async () => {
    const { store } = await freshStore();
    expect(store.setSecretRef('missing', { mode: 'none' })).rejects.toThrow();
  });

  test('the identity/url of a locked entry stays immutable via update() even after setSecretRef()', async () => {
    const { store } = await freshStore();
    const locked = await store.add(guardianInput({ id: 'conn-locked', locked: true }));
    await store.setSecretRef(locked.id, { mode: 'basic', secretRef: 'sec_1' });
    expect(store.update(locked.id, { url: 'http://evil.example' })).rejects.toThrow();
    expect((await store.get(locked.id))?.url).toBe('http://gw.example:8443');
  });
});

describe('active connection selection (P5b item 2)', () => {
  test('nothing is active initially, and add() does not implicitly activate', async () => {
    const { store } = await freshStore();
    expect(await store.getActiveId()).toBeNull();
    expect(await store.getActive()).toBeNull();
    await store.add(guardianInput());
    expect(await store.getActiveId()).toBeNull();
  });

  test('setActive() selects a stored entry; getActive() resolves it', async () => {
    const { store } = await freshStore();
    const a = await store.add(guardianInput({ label: 'A' }));
    const b = await store.add(guardianInput({ label: 'B' }));
    await store.setActive(b.id);
    expect(await store.getActiveId()).toBe(b.id);
    expect(await store.getActive()).toEqual(b);
    await store.setActive(a.id);
    expect(await store.getActiveId()).toBe(a.id);
  });

  test('setActive() rejects for an unknown id and leaves the selection unchanged', async () => {
    const { store } = await freshStore();
    const a = await store.add(guardianInput());
    await store.setActive(a.id);
    expect(store.setActive('missing')).rejects.toThrow();
    expect(await store.getActiveId()).toBe(a.id);
  });

  test('removing the active entry clears the selection (no dangling active id)', async () => {
    const { store } = await freshStore();
    const a = await store.add(guardianInput());
    await store.setActive(a.id);
    await store.remove(a.id);
    expect(await store.getActiveId()).toBeNull();
    expect(await store.getActive()).toBeNull();
  });

  test('entries and the active selection persist in the storage backend, not the store instance', async () => {
    // IndexedDB equivalence: a page reload constructs a NEW store over the
    // SAME persisted backend and must see identical state.
    const { createMemoryStorage, createConnectionStore } = await loadConnectionsModule();
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
