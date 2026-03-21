/**
 * GET  /admin/connections/assignments — Return current capabilities from stack.yaml.
 * POST /admin/connections/assignments — Update capabilities in stack.yaml.
 */
import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  appendAudit,
  readStackSpec,
  writeStackSpec,
  writeManagedEnvFiles,
} from '$lib/server/control-plane.js';
import {
  errorResponse,
  getActor,
  getCallerType,
  getRequestId,
  jsonResponse,
  parseJsonBody,
  requireAdmin,
} from '$lib/server/helpers.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const spec = readStackSpec(state.configDir);
  const capabilities = spec?.capabilities ?? null;

  appendAudit(state, getActor(event), 'connections.assignments.get', {}, true, requestId, getCallerType(event));
  return jsonResponse(200, { capabilities }, requestId);
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

  const raw = body.capabilities ?? body;
  if (typeof raw !== 'object' || raw === null) {
    return errorResponse(400, 'bad_request', 'capabilities must be an object', {}, requestId);
  }

  const capabilities = raw as Record<string, unknown>;

  const spec = readStackSpec(state.configDir);
  if (!spec) {
    return errorResponse(500, 'internal_error', 'stack.yaml not found', {}, requestId);
  }

  // Merge provided capabilities
  if (typeof capabilities.llm === 'string') spec.capabilities.llm = capabilities.llm;
  if (typeof capabilities.slm === 'string') spec.capabilities.slm = capabilities.slm;
  if (typeof capabilities.embeddings === 'object' && capabilities.embeddings !== null) {
    spec.capabilities.embeddings = { ...spec.capabilities.embeddings, ...(capabilities.embeddings as Record<string, unknown>) } as typeof spec.capabilities.embeddings;
  }
  if (typeof capabilities.memory === 'object' && capabilities.memory !== null) {
    spec.capabilities.memory = { ...spec.capabilities.memory, ...(capabilities.memory as Record<string, unknown>) } as typeof spec.capabilities.memory;
  }

  try {
    writeStackSpec(state.configDir, spec);
    writeManagedEnvFiles(spec, state.vaultDir);
  } catch (err) {
    appendAudit(state, actor, 'connections.assignments.save', { error: String(err) }, false, requestId, callerType);
    return errorResponse(500, 'internal_error', 'Failed to persist capabilities', {}, requestId);
  }

  appendAudit(state, actor, 'connections.assignments.save', {}, true, requestId, callerType);
  return jsonResponse(200, { ok: true, capabilities: spec.capabilities }, requestId);
};
