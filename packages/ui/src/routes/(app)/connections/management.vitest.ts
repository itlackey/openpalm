import { describe, expect, test, vi } from 'vitest';
import type {
  Connection,
  ConnectionStore,
  ConnectionUpdater,
} from '$lib/connections/store.js';
import type { SecretStore } from '$lib/connections/secrets.js';
import { removeManagedConnection, updateManagedConnection } from './management.js';

const EXISTING: Connection = {
  id: 'connection-1',
  label: 'Home',
  baseUrl: 'https://openpalm.example/oc',
  auth: { mode: 'basic', username: 'old-user', secretRef: 'old-secret' },
};

function dependencies(failAt?: string, current: Connection = EXISTING) {
  const calls: string[] = [];
  const secretRefs = new Set(current.auth.mode === 'basic' ? [current.auth.secretRef] : []);
  const store = {
    async updateWithPrevious(_id: string, update: ConnectionUpdater) {
      const patch = typeof update === 'function' ? update(current) : update;
      calls.push(`connection:update:${patch.auth?.mode ?? 'unchanged'}`);
      if (failAt === 'update') throw new Error('update failed');
      return { previous: current, updated: { ...current, ...patch } };
    },
    async remove() {
      calls.push('connection:remove');
      if (failAt === 'remove') throw new Error('remove failed');
      return current;
    },
  };
  const secrets = {
    async set(ref: string) {
      calls.push(`secret:set:${ref}`);
      if (failAt === 'secret:set') throw new Error('secret write failed');
      secretRefs.add(ref);
    },
    async delete(ref: string) {
      calls.push(`secret:delete:${ref}`);
      if (failAt === `secret:delete:${ref}`) throw new Error('secret cleanup failed');
      secretRefs.delete(ref);
    },
  };
  return {
    calls,
    secretRefs,
    store: store as Pick<ConnectionStore, 'updateWithPrevious' | 'remove'>,
    secrets: secrets as Pick<SecretStore, 'set' | 'delete'>,
  };
}

describe('updateManagedConnection', () => {
  test('writes a new credential, updates the connection, then removes the old credential', async () => {
    const deps = dependencies();
    const result = await updateManagedConnection(
      {
        connectionId: EXISTING.id,
        label: 'Renamed',
        baseUrl: EXISTING.baseUrl,
        username: 'new-user',
        password: 'new-password',
        clearPassword: false,
      },
      { ...deps, createId: () => 'new-secret' },
    );

    expect(result).toEqual({ ok: true });
    expect(deps.calls).toEqual([
      'secret:set:new-secret',
      'connection:update:basic',
      'secret:delete:old-secret',
    ]);
  });

  test('cleans the credential atomically replaced after another tab rotated the stale snapshot', async () => {
    const durable = {
      ...EXISTING,
      auth: { mode: 'basic', username: 'other-tab', secretRef: 'current-secret' },
    } satisfies Connection;
    const deps = dependencies(undefined, durable);

    const result = await updateManagedConnection(
      {
        connectionId: EXISTING.id,
        label: 'Renamed',
        baseUrl: EXISTING.baseUrl,
        username: 'this-tab',
        password: 'new-password',
        clearPassword: false,
      },
      { ...deps, createId: () => 'new-secret' },
    );

    expect(result).toEqual({ ok: true });
    expect(deps.calls).toEqual([
      'secret:set:new-secret',
      'connection:update:basic',
      'secret:delete:current-secret',
    ]);
    expect(deps.calls).not.toContain('secret:delete:old-secret');
    expect([...deps.secretRefs]).toEqual(['new-secret']);
  });

  test('preserves the old connection and credential when connection update fails', async () => {
    const deps = dependencies('update');
    const result = await updateManagedConnection(
      {
        connectionId: EXISTING.id,
        label: 'Home',
        baseUrl: EXISTING.baseUrl,
        username: 'new-user',
        password: 'new-password',
        clearPassword: false,
      },
      { ...deps, createId: () => 'new-secret' },
    );

    expect(result).toEqual({
      ok: false,
      error: 'The connection was not changed. Your previous password is still in use.',
    });
    expect(deps.calls).toEqual([
      'secret:set:new-secret',
      'connection:update:basic',
      'secret:delete:new-secret',
    ]);
    expect(deps.calls).not.toContain('secret:delete:old-secret');
  });

  test('reports an orphaned new credential if rollback cleanup also fails', async () => {
    const deps = dependencies('update');
    deps.secrets.delete = vi.fn(async (ref: string) => {
      deps.calls.push(`secret:delete:${ref}`);
      throw new Error('cleanup failed');
    });
    const result = await updateManagedConnection(
      {
        connectionId: EXISTING.id,
        label: 'Home',
        baseUrl: EXISTING.baseUrl,
        username: 'new-user',
        password: 'new-password',
        clearPassword: false,
      },
      { ...deps, createId: () => 'new-secret' },
    );

    expect(result).toEqual({
      ok: false,
      error:
        'The connection was not changed and your previous password is still in use, but the unused new password could not be removed from browser storage.',
    });
  });

  test('updates before deleting a cleared credential', async () => {
    const deps = dependencies();
    const result = await updateManagedConnection(
      {
        connectionId: EXISTING.id,
        label: 'Home',
        baseUrl: EXISTING.baseUrl,
        username: 'old-user',
        password: '',
        clearPassword: true,
      },
      { ...deps, createId: () => 'unused' },
    );
    expect(result).toEqual({ ok: true });
    expect(deps.calls).toEqual(['connection:update:none', 'secret:delete:old-secret']);
  });

  test('changes an inline username without rewriting the existing credential first', async () => {
    const deps = dependencies();
    const result = await updateManagedConnection(
      {
        connectionId: EXISTING.id,
        label: 'Home',
        baseUrl: EXISTING.baseUrl,
        username: 'new-user',
        password: '',
        clearPassword: false,
      },
      { ...deps, createId: () => 'unused' },
    );
    expect(result).toEqual({ ok: true });
    expect(deps.calls).toEqual(['connection:update:basic']);
  });
});

describe('removeManagedConnection', () => {
  test('removes the connection before deleting its orphaned credential', async () => {
    const deps = dependencies();
    expect(await removeManagedConnection(EXISTING.id, deps)).toEqual({ ok: true });
    expect(deps.calls).toEqual(['connection:remove', 'secret:delete:old-secret']);
  });

  test('cleans the credential atomically removed after another tab rotated the stale snapshot', async () => {
    const durable = {
      ...EXISTING,
      auth: { mode: 'basic', username: 'other-tab', secretRef: 'current-secret' },
    } satisfies Connection;
    const deps = dependencies(undefined, durable);

    expect(await removeManagedConnection(EXISTING.id, deps)).toEqual({ ok: true });
    expect(deps.calls).toEqual(['connection:remove', 'secret:delete:current-secret']);
    expect(deps.calls).not.toContain('secret:delete:old-secret');
    expect([...deps.secretRefs]).toEqual([]);
  });

  test('does not touch the credential when connection removal fails', async () => {
    const deps = dependencies('remove');
    expect(await removeManagedConnection(EXISTING.id, deps)).toEqual({
      ok: false,
      error: 'The connection could not be removed. Its saved password was not changed.',
    });
    expect(deps.calls).toEqual(['connection:remove']);
  });

  test('reports truthful cleanup state without restoring a removed connection', async () => {
    const deps = dependencies('secret:delete:old-secret');
    expect(await removeManagedConnection(EXISTING.id, deps)).toEqual({
      ok: true,
      warning:
        'The connection was removed, but its now-unused saved password could not be removed from browser storage.',
    });
    expect(deps.calls).toEqual(['connection:remove', 'secret:delete:old-secret']);
  });
});
