/**
 * /api/host/secrets/user-env — read/write the shared akm user env (`env:user`).
 *
 * The user env file (`knowledge/env/user.env`) is the sole source of truth for
 * user-managed configuration secrets. OpenPalm owns the file directly: writes
 * and deletes are plain atomic .env edits (mode 0600) — akm (>= 0.8.0) no
 * longer manages individual env entries.
 *
 * SECURITY: this module never spells a secret value on a process argv, and the
 * GET endpoint returns key names only — never values.
 */
import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
  requireCapability,
  withAdminBody,
} from '$lib/server/helpers.js';
import {
  AKM_USER_ENV_REF,
  createLogger,
  deleteUserEnvKey,
  ensureAkmUserEnv,
  readUserEnvFile,
  writeUserEnvKey,
} from '@openpalm/lib';

const logger = createLogger('admin.secrets.user-env');

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * GET — list keys in the akm env:user store. Values are NEVER returned.
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:secrets', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();

  const envPath = ensureAkmUserEnv(state);
  const keys = Object.keys(readUserEnvFile(envPath)).sort();

  return jsonResponse(200, {
    provider: 'akm',
    envRef: AKM_USER_ENV_REF,
    keys,
  }, requestId);
};

/**
 * POST — write a key into the user env file. The value is shell-quoted and
 * written directly to `knowledge/env/user.env` (mode 0600); it never appears on
 * a process argv. The assistant sources the env file at startup, so a key
 * written here is visible to OpenCode after the next assistant restart.
 */
export const POST: RequestHandler = async (event) => {
  const capabilityError = requireCapability(event, 'host:secrets', getRequestId(event));
  if (capabilityError) return capabilityError;
  return withAdminBody(event, async ({ requestId, body }) => {
    const state = getState();
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const value = typeof body.value === 'string' ? body.value : null;
    if (!key || value === null) {
      return errorResponse(400, 'bad_request', 'key and value are required', {}, requestId);
    }
    if (!KEY_RE.test(key)) {
      return errorResponse(400, 'invalid_key', 'key must match [A-Za-z_][A-Za-z0-9_]*', {}, requestId);
    }
    if (value.length === 0) {
      return errorResponse(400, 'bad_request', 'value must be non-empty; use DELETE to remove a key', {}, requestId);
    }
    // env values are single-line; a newline or control char would break the
    // line-oriented .env format that both the entrypoint `source` and dotenv
    // read back.
    const hasControlChar = [...value].some((ch) => {
      const code = ch.charCodeAt(0);
      return (code >= 0x00 && code <= 0x08) || (code >= 0x0a && code <= 0x1f) || code === 0x7f;
    });
    if (hasControlChar) {
      return errorResponse(400, 'invalid_value', 'value must not contain newlines or control characters', {}, requestId);
    }

    try {
      writeUserEnvKey(state, key, value);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Never log the value. The key name is fine — operators need to see which
      // entry failed when debugging from logs.
      logger.warn('user env write failed', { key, reason, requestId });
      return errorResponse(500, 'write_failed', `Failed to write user env key: ${reason}`, {}, requestId);
    }

    return jsonResponse(200, { ok: true, key }, requestId);
  });
};

/** DELETE — remove a key from the user env file. */
export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:secrets', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const key = new URL(event.request.url).searchParams.get('key')?.trim() ?? '';
  if (!key || !KEY_RE.test(key)) {
    return errorResponse(400, 'bad_request', 'valid key query parameter is required', {}, requestId);
  }

  try {
    deleteUserEnvKey(state, key);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('user env delete failed', { key, reason, requestId });
    return errorResponse(500, 'delete_failed', `Failed to remove user env key: ${reason}`, {}, requestId);
  }

  return jsonResponse(200, { ok: true, key }, requestId);
};
