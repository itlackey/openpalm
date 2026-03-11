import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  appendAudit,
  createConnectionProfile,
  deleteConnectionProfile,
  listConnectionProfiles,
  updateConnectionProfile,
  type CanonicalConnectionProfile,
} from '$lib/server/control-plane.js';
import {
  errorResponse,
  getCallerType,
  getRequestId,
  jsonResponse,
  parseCanonicalConnectionProfile,
  parseJsonBody,
  requireAdminOrSetupToken,
} from '$lib/server/helpers.js';

const ACTOR = 'setup';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdminOrSetupToken(event, requestId);
  if (authError) return authError;

  const state = getState();
  const profiles = listConnectionProfiles(state.configDir);
  appendAudit(state, ACTOR, 'setup.connections.profiles.get', {}, true, requestId, getCallerType(event));
  return jsonResponse(200, { profiles }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdminOrSetupToken(event, requestId);
  if (authError) return authError;

  const state = getState();
  const callerType = getCallerType(event);

  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, 'invalid_input', 'Request body must be valid JSON', {}, requestId);
  }
  const parsed = parseCanonicalConnectionProfile(body.profile);
  if (!parsed.ok) {
    return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
  }

  const result = createConnectionProfile(state.configDir, parsed.value as CanonicalConnectionProfile);
  if (!result.ok) {
    return errorResponse(result.status, result.status === 409 ? 'conflict' : 'bad_request', result.message, {}, requestId);
  }

  appendAudit(state, ACTOR, 'setup.connections.profiles.create', { id: result.value.id }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, profile: result.value }, requestId);
};

export const PUT: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdminOrSetupToken(event, requestId);
  if (authError) return authError;

  const state = getState();
  const callerType = getCallerType(event);

  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, 'invalid_input', 'Request body must be valid JSON', {}, requestId);
  }
  const parsed = parseCanonicalConnectionProfile(body.profile);
  if (!parsed.ok) {
    return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
  }

  const result = updateConnectionProfile(state.configDir, parsed.value as CanonicalConnectionProfile);
  if (!result.ok) {
    return errorResponse(result.status, result.status === 404 ? 'not_found' : 'bad_request', result.message, {}, requestId);
  }

  appendAudit(state, ACTOR, 'setup.connections.profiles.update', { id: result.value.id }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, profile: result.value }, requestId);
};

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdminOrSetupToken(event, requestId);
  if (authError) return authError;

  const state = getState();
  const callerType = getCallerType(event);

  const body = await parseJsonBody(event.request);
  if (!body || typeof body.id !== 'string') {
    return errorResponse(400, 'bad_request', 'profile id is required', {}, requestId);
  }

  const result = deleteConnectionProfile(state.configDir, body.id);
  if (!result.ok) {
    const errorCode = result.status === 404 ? 'not_found' : result.status === 409 ? 'conflict' : 'bad_request';
    return errorResponse(result.status, errorCode, result.message, {}, requestId);
  }

  appendAudit(state, ACTOR, 'setup.connections.profiles.delete', { id: result.value.id }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, id: result.value.id }, requestId);
};
