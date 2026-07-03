import { request, requireOk } from './core.js';

// ── User env (akm env:user) ───────────────────────────────────────────────────

export type UserEnvListResponse = {
  provider: 'akm';
  envRef: string;
  keys: string[];
};

export async function fetchUserEnv(): Promise<UserEnvListResponse> {
  const res = await requireOk(await request('GET', '/admin/secrets/user-env'));
  return (await res.json()) as UserEnvListResponse;
}

export async function writeUserEnvKey(key: string, value: string): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('POST', '/admin/secrets/user-env', { key, value }));
  return (await res.json()) as { ok: boolean };
}

export async function deleteUserEnvKey(key: string): Promise<{ ok: boolean }> {
  const res = await requireOk(
    await request('DELETE', `/admin/secrets/user-env?key=${encodeURIComponent(key)}`)
  );
  return (await res.json()) as { ok: boolean };
}

// ── Secret files (/stash/secrets file browser) ───────────────────────────────

export type SecretFileInfo = { name: string; size: number };

export async function fetchSecretFiles(): Promise<{ files: SecretFileInfo[] }> {
  const res = await requireOk(await request('GET', '/admin/secrets'));
  return (await res.json()) as { files: SecretFileInfo[] };
}

export async function fetchSecretFile(name: string): Promise<{ name: string; value: string }> {
  const res = await requireOk(await request('GET', `/admin/secrets/${encodeURIComponent(name)}`));
  return (await res.json()) as { name: string; value: string };
}

export async function saveSecretFile(name: string, value: string): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('PUT', `/admin/secrets/${encodeURIComponent(name)}`, { value }));
  return (await res.json()) as { ok: boolean };
}

export async function deleteSecretFile(name: string): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('DELETE', `/admin/secrets/${encodeURIComponent(name)}`));
  return (await res.json()) as { ok: boolean };
}
