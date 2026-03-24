import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, errorResponse, getRequestId, parseJsonBody } from '$lib/server/helpers.js';
import { getOpenCodeConfig, proxyToOpenCode } from '$lib/opencode/client.server.js';
import { getState } from '$lib/server/state.js';
import {
  updateCapability,
  formatCapabilityString,
  parseCapabilityString,
  readStackSpec,
  writeCapabilityVars,
} from '@openpalm/lib';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const config = await getOpenCodeConfig();
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

  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, 'invalid_input', 'Request body must be valid JSON', {}, requestId);
  }

  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) {
    return errorResponse(400, 'bad_request', 'model is required', {}, requestId);
  }

  const state = getState();

  try {
    // Read current LLM capability to preserve provider
    const spec = readStackSpec(state.configDir);
    if (!spec) {
      return errorResponse(500, 'internal_error', 'stack.yaml not found', {}, requestId);
    }

    const { provider } = parseCapabilityString(spec.capabilities.llm);
    updateCapability(state.configDir, 'llm', formatCapabilityString(provider, model));

    // Regenerate managed env files
    const updatedSpec = readStackSpec(state.configDir);
    if (updatedSpec) {
      writeCapabilityVars(updatedSpec, state.vaultDir);
    }
  } catch {
    return errorResponse(500, 'internal_error', 'Failed to persist model selection', {}, requestId);
  }

  try {
    const result = await proxyToOpenCode('/config', {
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
  } catch {
    return jsonResponse(200, {
      ok: true,
      liveApplied: false,
      restartRequired: true,
      message: 'Model saved. Restart the assistant container to apply.',
    }, requestId);
  }
};
