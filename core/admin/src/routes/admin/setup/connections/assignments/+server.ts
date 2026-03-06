import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  appendAudit,
  getCapabilityAssignments,
  saveCapabilityAssignments,
} from '$lib/server/control-plane.js';
import {
  errorResponse,
  getCallerType,
  getRequestId,
  jsonResponse,
  parseCapabilityAssignments,
  parseJsonBody,
  requireAdminOrSetupToken,
} from '$lib/server/helpers.js';

const ACTOR = 'setup';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdminOrSetupToken(event, requestId);
  if (authError) return authError;

  const state = getState();
  const assignments = getCapabilityAssignments(state.configDir);
  appendAudit(state, ACTOR, 'setup.connections.assignments.get', {}, true, requestId, getCallerType(event));
  return jsonResponse(200, { assignments }, requestId);
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

  const parsed = parseCapabilityAssignments(body.assignments ?? body);
  if (!parsed.ok) {
    return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
  }

  const result = saveCapabilityAssignments(state.configDir, parsed.value);
  if (!result.ok) {
    const errorCode = result.status === 409 ? 'conflict' : result.status === 404 ? 'not_found' : 'bad_request';
    return errorResponse(result.status, errorCode, result.message, {}, requestId);
  }

  appendAudit(state, ACTOR, 'setup.connections.assignments.save', {}, true, requestId, callerType);
  return jsonResponse(200, { ok: true, assignments: result.value }, requestId);
};
