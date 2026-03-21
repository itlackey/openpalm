import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  appendAudit,
  getCapabilityAssignments,
  saveCapabilityAssignments,
  readConnectionProfilesDocument,
  buildVoiceEnvVars,
  applyVoiceEnvVars,
  isVoiceChannelInstalled,
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

  const savedAssignments = result.value;

  // Read connection profiles document for side-effects (non-critical)
  let doc: ReturnType<typeof readConnectionProfilesDocument> | null = null;
  try {
    doc = readConnectionProfilesDocument(state.configDir);
  } catch (err) {
    logger.warn('failed to read connection profiles for side-effects', { error: String(err), requestId });
  }

  // Wire voice channel env vars (non-critical side effect)
  let voiceConfigUpdated = false;
  let voiceRestartRequired = false;
  if (doc) {
    try {
      if (isVoiceChannelInstalled(state.homeDir) && (savedAssignments.tts || savedAssignments.stt)) {
        const envVars = buildVoiceEnvVars(savedAssignments, doc.profiles, state.vaultDir);
        if (Object.keys(envVars).length > 0) {
          voiceConfigUpdated = applyVoiceEnvVars(state, envVars);
          voiceRestartRequired = voiceConfigUpdated;
        }
      }
    } catch (err) {
      logger.warn('failed to update voice env vars after assignments save', { error: String(err), requestId });
    }
  }

  appendAudit(state, actor, 'connections.assignments.save', {}, true, requestId, callerType);
  return jsonResponse(200, {
    ok: true,
    assignments: result.value,
    voiceConfigUpdated,
    voiceRestartRequired,
  }, requestId);
};
