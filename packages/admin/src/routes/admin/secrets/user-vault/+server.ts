/**
 * /admin/secrets/user-vault — read/write the shared akm user vault.
 *
 * Phase 2 of #388 (closed by #406): the akm `vault:user` store is now the
 * sole source of truth for user-managed env secrets. The legacy
 * `vault/user/user.env` mirror is gone — writes go straight to akm via
 * `akm vault set` with the value delivered on stdin (never on argv), and
 * deletes call `akm vault unset`.
 *
 * SECURITY: this module never spells a secret value on a process argv.
 * Both writeAkmVaultKey and deleteAkmVaultKey route through akm-cli's
 * stdin-mode set / argv-safe unset commands, so no secret can leak
 * through `/proc/<pid>/cmdline`.
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
  createLogger,
  deleteAkmVaultKey,
  ensureAkmUserVault,
  readAkmUserVaultFile,
  writeAkmVaultKey,
} from '@openpalm/lib';

const logger = createLogger('admin.secrets.user-vault');

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

  const vaultPath = await ensureAkmUserVault(state);
  const keys = vaultPath ? Object.keys(readAkmUserVaultFile(vaultPath)).sort() : [];

  appendAudit(
    state,
    actor,
    'secrets.user-vault.list',
    { count: keys.length, source: vaultPath ? 'akm' : 'unavailable' },
    true,
    requestId,
    callerType,
  );

  return jsonResponse(200, {
    provider: 'akm',
    vaultRef: AKM_USER_VAULT_REF,
    available: Boolean(vaultPath),
    keys,
  }, requestId);
};

/**
 * PUT/POST — write a key into the akm vault. The value is piped to
 * `akm vault set` via stdin, so it never appears on the akm argv. The
 * assistant entrypoint sources the akm vault file at container start; a
 * key written here will be visible to OpenCode after the next assistant
 * recreate. (Hot-reload of the akm vault is out of scope for Phase 2 —
 * see follow-up issue.)
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

  let written = false;
  let writeError: string | undefined;
  try {
    written = await writeAkmVaultKey(state, key, value);
    if (!written) writeError = 'akm_unavailable';
  } catch (err) {
    written = false;
    writeError = err instanceof Error ? err.message : String(err);
    // Never log the value. The key name is fine — operators need to see
    // which entry failed when debugging from logs.
    logger.warn('akm vault set failed', { key, reason: writeError, requestId });
  }

  if (!written) {
    appendAudit(
      state,
      actor,
      'secrets.user-vault.write',
      { key, error: writeError ?? 'unknown' },
      false,
      requestId,
      callerType,
    );
    return errorResponse(
      503,
      'akm_unavailable',
      `Failed to write to akm vault: ${writeError ?? 'unknown error'}`,
      {},
      requestId,
    );
  }

  appendAudit(
    state,
    actor,
    'secrets.user-vault.write',
    { key },
    true,
    requestId,
    callerType,
  );

  return jsonResponse(200, { ok: true, key }, requestId);
};

/** DELETE — remove a key from the akm vault. */
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

  let removed = false;
  let removeError: string | undefined;
  try {
    removed = await deleteAkmVaultKey(state, key);
    if (!removed) removeError = 'akm_unavailable';
  } catch (err) {
    removed = false;
    removeError = err instanceof Error ? err.message : String(err);
    logger.warn('akm vault unset failed', { key, reason: removeError, requestId });
  }

  if (!removed) {
    appendAudit(
      state,
      actor,
      'secrets.user-vault.remove',
      { key, error: removeError ?? 'unknown' },
      false,
      requestId,
      callerType,
    );
    return errorResponse(
      503,
      'akm_unavailable',
      `Failed to remove key from akm vault: ${removeError ?? 'unknown error'}`,
      {},
      requestId,
    );
  }

  appendAudit(
    state,
    actor,
    'secrets.user-vault.remove',
    { key },
    true,
    requestId,
    callerType,
  );

  return jsonResponse(200, { ok: true, key }, requestId);
};
