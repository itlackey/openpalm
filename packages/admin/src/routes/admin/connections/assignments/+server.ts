import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  appendAudit,
  getCapabilityAssignments,
  saveCapabilityAssignments,
  buildOpenCodeMapping,
  writeOpenCodeProviderConfig,
  readConnectionProfilesDocument,
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
import { createLogger } from '$lib/server/logger.js';

const logger = createLogger('connections.assignments');

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

  // Wire OpenCode config write (non-critical side effect)
  try {
    const doc = readConnectionProfilesDocument(state.configDir);
    const savedAssignments = result.value;
    const llmProfile = doc.profiles.find((p) => p.id === savedAssignments.llm.connectionId);
    if (llmProfile) {
      const mapping = buildOpenCodeMapping({
        provider: llmProfile.provider,
        baseUrl: llmProfile.baseUrl,
        systemModel: savedAssignments.llm.model,
        smallModel: savedAssignments.llm.smallModel,
      });
      writeOpenCodeProviderConfig(state.configDir, mapping);
    }
  } catch (err) {
    logger.warn('failed to write opencode.json after assignments save', { error: String(err), requestId });
  }

  appendAudit(state, actor, 'connections.assignments.save', {}, true, requestId, callerType);
  return jsonResponse(200, { ok: true, assignments: result.value }, requestId);
};
