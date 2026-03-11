import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  appendAudit,
  deleteConnectionProfile,
  listConnectionProfiles,
  updateConnectionProfile,
  type CanonicalConnectionProfile,
} from '$lib/server/control-plane.js';
import {
  errorResponse,
  getActor,
  getCallerType,
  getRequestId,
  jsonResponse,
  parseCanonicalConnectionProfile,
  parseJsonBody,
  requireAdmin,
} from '$lib/server/helpers.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const { id } = event.params;
  const state = getState();

  let profiles: CanonicalConnectionProfile[];
  try {
    profiles = listConnectionProfiles(state.configDir);
  } catch {
    return errorResponse(404, 'not_found', `Profile '${id}' not found`, {}, requestId);
  }

  const profile = profiles.find((p) => p.id === id);
  if (!profile) {
    return errorResponse(404, 'not_found', `Profile '${id}' not found`, {}, requestId);
  }

  appendAudit(state, getActor(event), 'connections.profiles.get', { id }, true, requestId, getCallerType(event));
  return jsonResponse(200, { profile }, requestId);
};

export const PUT: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const { id } = event.params;
  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, 'invalid_input', 'Request body must be valid JSON', {}, requestId);
  }

  // Use the URL param id as the authoritative profile id
  const rawProfile = typeof body.profile === 'object' && body.profile !== null
    ? { ...body.profile, id }
    : { id };

  const parsed = parseCanonicalConnectionProfile(rawProfile);
  if (!parsed.ok) {
    return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
  }

  const result = updateConnectionProfile(state.configDir, parsed.value as CanonicalConnectionProfile);
  if (!result.ok) {
    const errorCode = result.status === 404 ? 'not_found' : 'bad_request';
    return errorResponse(result.status, errorCode, result.message, {}, requestId);
  }

  appendAudit(state, actor, 'connections.profiles.update', { id: result.value.id }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, profile: result.value }, requestId);
};

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const { id } = event.params;
  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const result = deleteConnectionProfile(state.configDir, id);
  if (!result.ok) {
    const errorCode = result.status === 404 ? 'not_found' : result.status === 409 ? 'conflict' : 'bad_request';
    return errorResponse(result.status, errorCode, result.message, {}, requestId);
  }

  appendAudit(state, actor, 'connections.profiles.delete', { id: result.value.id }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, id: result.value.id }, requestId);
};
