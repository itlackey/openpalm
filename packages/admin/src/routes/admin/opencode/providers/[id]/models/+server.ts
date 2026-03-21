import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, getRequestId, errorResponse } from '$lib/server/helpers.js';
import { proxyToOpenCode } from '$lib/opencode/client.server.js';
import { sanitizeOpenCodeModels } from '$lib/opencode/provider-models.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const providerId = event.params.id;
  const result = await proxyToOpenCode('/provider');
  if (!result.ok) {
    return errorResponse(result.status, result.code, result.message, {}, requestId);
  }

  const data = result.data as { all?: Array<{ id: string; models?: Record<string, unknown> }> };
  const provider = data.all?.find((p) => p.id === providerId);
  if (!provider || !provider.models) {
    return jsonResponse(200, { models: [] }, requestId);
  }

  const models = sanitizeOpenCodeModels(provider.models, providerId);

  return jsonResponse(200, { models }, requestId);
};
