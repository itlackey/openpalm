import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, errorResponse, getRequestId, parseJsonBody, jsonBodyError, getOpenCodeClient } from '$lib/server/helpers.js';
import { getState } from '$lib/server/state.js';
import {
  formatCapabilityString,
  parseCapabilityString,
  readStackSpec,
  writeStackSpec,
  writeCapabilityVars,
} from '@openpalm/lib';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const config = await getOpenCodeClient().getConfig();
  if (!config) {
    return errorResponse(503, 'opencode_unavailable', 'OpenCode is not reachable', {}, requestId);
  }

  return jsonResponse(200, {
    model: config.model ?? '',
  }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const body = result.data;

  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) {
    return errorResponse(400, 'bad_request', 'model is required', {}, requestId);
  }

  const state = getState();

  try {
    // Read current LLM capability to preserve provider, then update and persist
    const currentSpec = readStackSpec(state.stackDir);
    if (!currentSpec) {
      return errorResponse(500, 'internal_error', 'stack.yml not found', {}, requestId);
    }
    const { provider } = parseCapabilityString(currentSpec.capabilities.llm);

    currentSpec.capabilities.llm = formatCapabilityString(provider, model);
    writeStackSpec(state.stackDir, currentSpec);
    writeCapabilityVars(currentSpec, state.stackDir, state.homeDir);
  } catch (e) {
    console.warn('[opencode.model] Failed to persist model selection', e);
    return errorResponse(500, 'internal_error', 'Failed to persist model selection', {}, requestId);
  }

  try {
    const result = await getOpenCodeClient().proxy('/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });

    if (!result.ok) {
      // 4xx from OpenCode means the caller sent something invalid — surface it.
      // 5xx / network failures are non-critical because config was already persisted;
      // the container just needs a restart to pick up the change.
      if (result.status >= 400 && result.status < 500) {
        return errorResponse(result.status, result.code, result.message, {}, requestId);
      }

      return jsonResponse(200, {
        ok: true,
        liveApplied: false,
        restartRequired: true,
        message: 'Model saved. Restart the assistant container to apply.',
      }, requestId);
    }

    return jsonResponse(200, {
      ok: true,
      liveApplied: true,
      restartRequired: false,
      message: 'Model updated successfully',
    }, requestId);
  } catch (e) {
    console.warn('[opencode.model] Failed to proxy model change to OpenCode', e);
    return jsonResponse(200, {
      ok: true,
      liveApplied: false,
      restartRequired: true,
      message: 'Model saved. Restart the assistant container to apply.',
    }, requestId);
  }
};
