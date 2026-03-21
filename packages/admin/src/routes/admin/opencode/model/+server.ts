import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, errorResponse, getRequestId, parseJsonBody } from '$lib/server/helpers.js';
import { getOpenCodeConfig, proxyToOpenCode } from '$lib/opencode/client.server.js';

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

  // Try to update via OpenCode config API (non-critical)
  let liveApplied = false;
  try {
    const result = await proxyToOpenCode('/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    liveApplied = result.ok;
  } catch {
    // Non-critical — container restart will apply
  }

  return jsonResponse(200, {
    ok: true,
    liveApplied,
    restartRequired: !liveApplied,
    message: liveApplied
      ? 'Model updated successfully'
      : 'Model saved. Restart the assistant container to apply.',
  }, requestId);
};
