import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  appendAudit,
  getCapabilityAssignments,
  saveCapabilityAssignments,
} from '$lib/server/control-plane.js';
import {
  errorResponse,
  getActor,
  getCallerType,
  getRequestId,
  jsonResponse,
  parseCapabilityAssignments,
  parseJsonBody,
  requireAdmin,
} from '$lib/server/helpers.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  let assignments;
  try {
    assignments = getCapabilityAssignments(state.configDir);
  } catch {
    // No profiles.json yet — return empty defaults
    assignments = { llm: { connectionId: '', model: '' }, embeddings: { connectionId: '', model: '' } };
  }
  appendAudit(state, getActor(event), 'connections.assignments.get', {}, true, requestId, getCallerType(event));
  return jsonResponse(200, { assignments }, requestId);
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

  const parsed = parseCapabilityAssignments(body.assignments ?? body);
  if (!parsed.ok) {
    return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
  }

  const result = saveCapabilityAssignments(state.configDir, parsed.value);
  if (!result.ok) {
    const errorCode = result.status === 409 ? 'conflict' : result.status === 404 ? 'not_found' : 'bad_request';
    return errorResponse(result.status, errorCode, result.message, {}, requestId);
  }

  appendAudit(state, actor, 'connections.assignments.save', {}, true, requestId, callerType);
  return jsonResponse(200, { ok: true, assignments: result.value }, requestId);
};
