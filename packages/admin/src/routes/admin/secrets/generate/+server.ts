import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getActor,
  getCallerType,
  getRequestId,
  jsonResponse,
  parseJsonBody,
  requireAdmin,
} from '$lib/server/helpers.js';
import {
  appendAudit,
  detectSecretBackend,
} from '@openpalm/lib';
import { validatePassEntryName } from '@openpalm/lib';

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, 'invalid_input', 'Request body must be valid JSON', {}, requestId);
  }

  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const length = typeof body.length === 'number' ? body.length : 32;
  if (!key) {
    return errorResponse(400, 'bad_request', 'key is required', {}, requestId);
  }
  if (!Number.isInteger(length) || length < 16 || length > 4096) {
    return errorResponse(400, 'bad_request', 'length must be an integer between 16 and 4096', {}, requestId);
  }

  try {
    validatePassEntryName(key);
  } catch (err) {
    return errorResponse(400, 'invalid_key', String(err instanceof Error ? err.message : err), {}, requestId);
  }

  try {
    const backend = detectSecretBackend(state);
    if (!backend.capabilities.generate) {
      return errorResponse(400, 'unsupported_operation', 'Secret backend does not support generation', {}, requestId);
    }
    const entry = await backend.generate(key, length);
    appendAudit(
      state,
      actor,
      'secrets.generate',
      { key, length, provider: backend.provider, scope: entry.scope, kind: entry.kind },
      true,
      requestId,
      callerType,
    );
    return jsonResponse(200, { ok: true, provider: backend.provider, entry }, requestId);
  } catch (error) {
    appendAudit(
      state,
      actor,
      'secrets.generate',
      { key, length, error: String(error) },
      false,
      requestId,
      callerType,
    );
    return errorResponse(500, 'internal_error', 'Failed to generate secret', {}, requestId);
  }
};
