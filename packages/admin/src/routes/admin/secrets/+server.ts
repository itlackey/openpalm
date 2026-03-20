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
} from '$lib/server/control-plane.js';

function getSecretKeyFromInput(body: Record<string, unknown>): string | null {
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  return key.length > 0 ? key : null;
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const prefix = new URL(event.request.url).searchParams.get('prefix') ?? 'openpalm/';
  const backend = detectSecretBackend(state);
  const entries = await backend.list(prefix);

  appendAudit(
    state,
    actor,
    'secrets.list',
    { prefix, provider: backend.provider, count: entries.length },
    true,
    requestId,
    callerType,
  );

  return jsonResponse(200, {
    provider: backend.provider,
    capabilities: backend.capabilities,
    entries,
  }, requestId);
};

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

  const key = getSecretKeyFromInput(body);
  const value = typeof body.value === 'string' ? body.value : null;
  if (!key || value === null) {
    return errorResponse(400, 'bad_request', 'key and value are required', {}, requestId);
  }
  if (value.length === 0) {
    return errorResponse(400, 'bad_request', 'value must be non-empty; use DELETE to remove a secret', {}, requestId);
  }

  try {
    const backend = detectSecretBackend(state);
    const entry = await backend.write(key, value);
    appendAudit(
      state,
      actor,
      'secrets.write',
      { key, provider: backend.provider, scope: entry.scope, kind: entry.kind },
      true,
      requestId,
      callerType,
    );
    return jsonResponse(200, { ok: true, provider: backend.provider, entry }, requestId);
  } catch (error) {
    appendAudit(
      state,
      actor,
      'secrets.write',
      { key, error: String(error) },
      false,
      requestId,
      callerType,
    );
    return errorResponse(500, 'internal_error', 'Failed to write secret', {}, requestId);
  }
};

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const key = new URL(event.request.url).searchParams.get('key')?.trim() ?? '';
  if (!key) {
    return errorResponse(400, 'bad_request', 'key query parameter is required', {}, requestId);
  }

  try {
    const backend = detectSecretBackend(state);
    await backend.remove(key);
    appendAudit(
      state,
      actor,
      'secrets.remove',
      { key, provider: backend.provider },
      true,
      requestId,
      callerType,
    );
    return jsonResponse(200, { ok: true, key, provider: backend.provider }, requestId);
  } catch (error) {
    appendAudit(
      state,
      actor,
      'secrets.remove',
      { key, error: String(error) },
      false,
      requestId,
      callerType,
    );
    return errorResponse(500, 'internal_error', 'Failed to remove secret', {}, requestId);
  }
};
