/**
 * /admin/secrets/user-vault — read/write the shared akm user vault.
 *
 * Phase 1 of #388: this endpoint surfaces the same `vault:user` keys
 * that `mirrorUserVaultToAkm()` populates during install/upgrade. The
 * underlying compose runtime source of truth (`vault/user/user.env`)
 * is kept in sync on writes so Docker Compose env_file resolution
 * never diverges from what the admin UI shows.
 *
 * NOTE: We deliberately do NOT route admin secret writes through this
 * endpoint by default — operator-managed `stack.env` secrets remain in
 * the existing `/admin/secrets` plaintext/pass backends. This endpoint
 * is scoped to user-extension keys only.
 */
import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getActor,
  getCallerType,
  getRequestId,
  jsonResponse,
  parseJsonBody,
  jsonBodyError,
  requireAdmin,
} from '$lib/server/helpers.js';
import {
  appendAudit,
  ensureAkmUserVault,
  mirrorUserVaultToAkm,
  readAkmUserVaultFile,
  parseEnvFile,
  mergeEnvContent,
} from '@openpalm/lib';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function buildAkmEnv(state: ReturnType<typeof getState>): NodeJS.ProcessEnv {
  const stashRoot = `${state.dataDir}/stash`;
  return {
    ...process.env,
    AKM_STASH_DIR: stashRoot,
    AKM_DATA_DIR: `${stashRoot}/.data`,
    AKM_STATE_DIR: `${stashRoot}/.state`,
    AKM_CONFIG_DIR: `${stashRoot}/.config`,
    AKM_CACHE_DIR: `${state.dataDir}/akm-cache`,
  };
}

function writeUserEnvKey(vaultDir: string, key: string, value: string): void {
  const userEnvPath = `${vaultDir}/user/user.env`;
  mkdirSync(`${vaultDir}/user`, { recursive: true, mode: 0o700 });
  const existing = existsSync(userEnvPath) ? readFileSync(userEnvPath, 'utf-8') : '';
  const merged = mergeEnvContent(existing, { [key]: value });
  writeFileSync(userEnvPath, merged.endsWith('\n') ? merged : merged + '\n', { mode: 0o600 });
}

/**
 * GET — list keys in the akm vault:user store. Values are NEVER returned
 * so this endpoint behaves identically whether the underlying backend
 * exposes plaintext or encrypted secrets.
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  // Ensure mirror is up to date before listing so a freshly-installed
  // stack shows the seeded keys without a separate /upgrade call.
  try { await mirrorUserVaultToAkm(state); } catch { /* best-effort */ }

  const vaultPath = await ensureAkmUserVault(state);
  const userEnvPath = `${state.vaultDir}/user/user.env`;
  const akmKeys = vaultPath ? Object.keys(readAkmUserVaultFile(vaultPath)) : [];
  const fileKeys = Object.keys(parseEnvFile(userEnvPath));
  const merged = Array.from(new Set([...akmKeys, ...fileKeys])).sort();

  appendAudit(
    state,
    actor,
    'secrets.user-vault.list',
    { count: merged.length, source: vaultPath ? 'akm+file' : 'file-only' },
    true,
    requestId,
    callerType,
  );

  return jsonResponse(200, {
    provider: 'akm-mirror',
    vaultRef: 'vault:user',
    available: Boolean(vaultPath),
    keys: merged,
  }, requestId);
};

/**
 * PUT/POST — write a key into both the akm vault and the runtime user.env
 * file. Both writes happen so Compose env_file consumption stays in sync
 * with what the admin UI displays.
 */
export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);

  const key = typeof result.data.key === 'string' ? result.data.key.trim() : '';
  const value = typeof result.data.value === 'string' ? result.data.value : null;
  if (!key || value === null) {
    return errorResponse(400, 'bad_request', 'key and value are required', {}, requestId);
  }
  if (!KEY_RE.test(key)) {
    return errorResponse(400, 'invalid_key', 'key must match [A-Za-z_][A-Za-z0-9_]*', {}, requestId);
  }
  if (value.length === 0) {
    return errorResponse(400, 'bad_request', 'value must be non-empty; use DELETE to remove a key', {}, requestId);
  }

  // 1. Write to user.env (compose runtime source of truth).
  try {
    writeUserEnvKey(state.vaultDir, key, value);
  } catch (err) {
    appendAudit(state, actor, 'secrets.user-vault.write', { key, error: String(err) }, false, requestId, callerType);
    return errorResponse(500, 'internal_error', 'Failed to update user.env', {}, requestId);
  }

  // 2. Mirror into akm. If akm is unavailable the .env write still
  //    succeeded, so we report partial success rather than a hard error.
  let akmOk = false;
  try {
    const env = buildAkmEnv(state);
    await execFile('akm', ['vault', 'create', 'vault:user'], { env }).catch(() => { /* idempotent */ });
    await execFile('akm', ['vault', 'set', 'vault:user', key, value], { env });
    akmOk = true;
  } catch {
    akmOk = false;
  }

  appendAudit(
    state,
    actor,
    'secrets.user-vault.write',
    { key, mirrored: akmOk },
    true,
    requestId,
    callerType,
  );

  return jsonResponse(200, { ok: true, key, mirrored: akmOk }, requestId);
};

/** DELETE — remove a key from both the akm vault and user.env. */
export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const key = new URL(event.request.url).searchParams.get('key')?.trim() ?? '';
  if (!key || !KEY_RE.test(key)) {
    return errorResponse(400, 'bad_request', 'valid key query parameter is required', {}, requestId);
  }

  // 1. Drop from user.env by setting to empty (the .env file format treats
  //    empty values as cleared; downstream Compose env_file sees no value).
  try {
    writeUserEnvKey(state.vaultDir, key, '');
  } catch (err) {
    appendAudit(state, actor, 'secrets.user-vault.remove', { key, error: String(err) }, false, requestId, callerType);
    return errorResponse(500, 'internal_error', 'Failed to update user.env', {}, requestId);
  }

  // 2. Drop from akm vault.
  let akmOk = false;
  try {
    const env = buildAkmEnv(state);
    await execFile('akm', ['vault', 'unset', 'vault:user', key], { env });
    akmOk = true;
  } catch {
    akmOk = false;
  }

  appendAudit(
    state,
    actor,
    'secrets.user-vault.remove',
    { key, mirrored: akmOk },
    true,
    requestId,
    callerType,
  );

  return jsonResponse(200, { ok: true, key, mirrored: akmOk }, requestId);
};
