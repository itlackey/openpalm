import type { SecretStore } from '$lib/connections/secrets.js';
import type { Connection, ConnectionStore } from '$lib/connections/store.js';

type MutationResult = { ok: true; warning?: string } | { ok: false; error: string };

type UpdateInput = {
  connectionId: string;
  label: string;
  baseUrl: string;
  username: string;
  password: string;
  clearPassword: boolean;
};

type UpdateDependencies = {
  store: Pick<ConnectionStore, 'updateWithPrevious'>;
  secrets: Pick<SecretStore, 'set' | 'delete'>;
  createId: () => string;
};

type RemoveDependencies = {
  store: Pick<ConnectionStore, 'remove'>;
  secrets: Pick<SecretStore, 'delete'>;
};

const OLD_SECRET_CLEANUP_WARNING =
  'The connection was updated, but its now-unused saved password could not be removed from browser storage.';

export async function updateManagedConnection(
  input: UpdateInput,
  dependencies: UpdateDependencies,
): Promise<MutationResult> {
  const patch = { label: input.label, baseUrl: input.baseUrl };

  if (input.clearPassword) {
    let previous: Connection;
    try {
      ({ previous } = await dependencies.store.updateWithPrevious(input.connectionId, {
        ...patch,
        auth: { mode: 'none' },
      }));
    } catch {
      return {
        ok: false,
        error: 'The connection could not be updated. Its saved password was not changed.',
      };
    }
    if (previous.auth.mode === 'basic') {
      try {
        await dependencies.secrets.delete(previous.auth.secretRef);
      } catch {
        return { ok: true, warning: OLD_SECRET_CLEANUP_WARNING };
      }
    }
    return { ok: true };
  }

  if (input.password) {
    const newSecretRef = dependencies.createId();
    try {
      await dependencies.secrets.set(newSecretRef, {
        username: input.username,
        password: input.password,
      });
    } catch {
      return {
        ok: false,
        error: 'The connection was not changed because the new password could not be saved.',
      };
    }

    try {
      const { previous } = await dependencies.store.updateWithPrevious(input.connectionId, {
        ...patch,
        auth: { mode: 'basic', username: input.username, secretRef: newSecretRef },
      });
      if (previous.auth.mode === 'basic' && previous.auth.secretRef !== newSecretRef) {
        try {
          await dependencies.secrets.delete(previous.auth.secretRef);
        } catch {
          return { ok: true, warning: OLD_SECRET_CLEANUP_WARNING };
        }
      }
    } catch {
      try {
        await dependencies.secrets.delete(newSecretRef);
      } catch {
        return {
          ok: false,
          error:
            'The connection was not changed and your previous password is still in use, but the unused new password could not be removed from browser storage.',
        };
      }
      return {
        ok: false,
        error: 'The connection was not changed. Your previous password is still in use.',
      };
    }
    return { ok: true };
  }

  try {
    await dependencies.store.updateWithPrevious(input.connectionId, (current) => ({
      ...patch,
      auth:
        current.auth.mode === 'basic'
          ? { ...current.auth, username: input.username }
          : { mode: 'none' },
    }));
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: 'The connection could not be updated. Its saved password was not changed.',
    };
  }
}

export async function removeManagedConnection(
  connectionId: string,
  dependencies: RemoveDependencies,
): Promise<MutationResult> {
  let removed: Connection;
  try {
    removed = await dependencies.store.remove(connectionId);
  } catch {
    return {
      ok: false,
      error: 'The connection could not be removed. Its saved password was not changed.',
    };
  }

  if (removed.auth.mode === 'basic') {
    try {
      await dependencies.secrets.delete(removed.auth.secretRef);
    } catch {
      return {
        ok: true,
        warning:
          'The connection was removed, but its now-unused saved password could not be removed from browser storage.',
      };
    }
  }
  return { ok: true };
}
