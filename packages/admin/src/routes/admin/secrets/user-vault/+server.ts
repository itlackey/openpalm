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
 *
 * SECURITY: writes go DIRECTLY to the akm vault .env file via lib's
 * `writeAkmVaultKey`/`deleteAkmVaultKey` helpers. We never pass secret
 * values on the `akm` argv, since that would expose them through
 * `/proc/<pid>/cmdline`.
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
  AKM_USER_VAULT_REF,
  appendAudit,
  deleteAkmVaultKey,
  ensureAkmUserVault,
  mergeEnvContent,
  parseEnvFile,
  readAkmUserVaultFile,
  removeEnvKey,
  writeAkmVaultKey,
} from '@openpalm/lib';
import { createLogger } from '$lib/server/logger.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const logger = createLogger('admin.secrets.user-vault');

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function writeUserEnvKey(vaultDir: string, key: string, value: string): void {
  const userEnvPath = `${vaultDir}/user/user.env`;
  mkdirSync(`${vaultDir}/user`, { recursive: true, mode: 0o700 });
  const existing = existsSync(userEnvPath) ? readFileSync(userEnvPath, 'utf-8') : '';
  const merged = mergeEnvContent(existing, { [key]: value });
  writeFileSync(userEnvPath, merged.endsWith('\n') ? merged : merged + '\n', { mode: 0o600 });
}

function removeUserEnvKey(vaultDir: string, key: string): void {
  const userEnvPath = `${vaultDir}/user/user.env`;
  if (!existsSync(userEnvPath)) return;
  const existing = readFileSync(userEnvPath, 'utf-8');
  const stripped = removeEnvKey(existing, key);
  writeFileSync(userEnvPath, stripped.endsWith('\n') ? stripped : stripped + '\n', { mode: 0o600 });
}

/**
 * GET — list keys in the akm vault:user store. Values are NEVER returned
 * so this endpoint behaves identically whether the underlying backend
 * exposes plaintext or encrypted secrets.
 *
 * Mirror is NOT run on GET — it is part of install/upgrade lifecycle only.
 * Calling akm on every list would be wasteful and surface transient
 * akm-CLI failures as list errors.
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const vaultPath = await ensureAkmUserVault(state);
  const userEnvPath = `${state.vaultDir}/user/user.env`;
  const akmKeys = vaultPath ? Object.keys(readAkmUserVaultFile(vaultPath)) : [];
  const fileEntries = parseEnvFile(userEnvPath);
  // Filter empty values so cleared keys don't show up post-DELETE if the
  // file write path ever leaves a `KEY=` line behind.
  const fileKeys = Object.keys(fileEntries).filter((k) => fileEntries[k] !== '');
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
    vaultRef: AKM_USER_VAULT_REF,
    available: Boolean(vaultPath),
    keys: merged,
  }, requestId);
};

/**
 * PUT/POST — write a key into both the akm vault and the runtime user.env
 * file. Both writes happen so Compose env_file consumption stays in sync
 * with what the admin UI displays.
 *
 * If the akm write fails the .env update still succeeds (since Compose is
 * the runtime source of truth), but the response surfaces `mirrored:false`
 * and an `error` field so callers can decide whether to retry. A warn-level
 * log is emitted for operators (key name only, never the value).
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

  // 2. Mirror into the akm vault file by writing directly (no argv exposure).
  let mirrored = false;
  let mirrorError: string | undefined;
  try {
    mirrored = await writeAkmVaultKey(state, key, value);
    if (!mirrored) mirrorError = 'akm_unavailable';
  } catch (err) {
    mirrored = false;
    mirrorError = err instanceof Error ? err.message : String(err);
  }

  if (!mirrored) {
    // Divergence is recoverable (re-running upgrade re-mirrors) but
    // operators need to see it. Never log the value.
    logger.warn('akm vault write failed; user.env and akm vault are diverged', {
      key,
      reason: mirrorError,
      requestId,
    });
  }

  appendAudit(
    state,
    actor,
    'secrets.user-vault.write',
    { key, mirrored, ...(mirrorError ? { mirrorError } : {}) },
    true,
    requestId,
    callerType,
  );

  return jsonResponse(200, {
    ok: true,
    key,
    mirrored,
    ...(mirrorError ? { error: mirrorError } : {}),
  }, requestId);
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

  // 1. Remove from user.env entirely (clean semantics — no empty-valued
  //    stub line left behind for GET to filter out).
  try {
    removeUserEnvKey(state.vaultDir, key);
  } catch (err) {
    appendAudit(state, actor, 'secrets.user-vault.remove', { key, error: String(err) }, false, requestId, callerType);
    return errorResponse(500, 'internal_error', 'Failed to update user.env', {}, requestId);
  }

  // 2. Drop from akm vault file directly (no argv exposure).
  let mirrored = false;
  let mirrorError: string | undefined;
  try {
    mirrored = await deleteAkmVaultKey(state, key);
    if (!mirrored) mirrorError = 'akm_unavailable';
  } catch (err) {
    mirrored = false;
    mirrorError = err instanceof Error ? err.message : String(err);
  }

  if (!mirrored) {
    logger.warn('akm vault delete failed; user.env and akm vault are diverged', {
      key,
      reason: mirrorError,
      requestId,
    });
  }

  appendAudit(
    state,
    actor,
    'secrets.user-vault.remove',
    { key, mirrored, ...(mirrorError ? { mirrorError } : {}) },
    true,
    requestId,
    callerType,
  );

  return jsonResponse(200, {
    ok: true,
    key,
    mirrored,
    ...(mirrorError ? { error: mirrorError } : {}),
  }, requestId);
};
