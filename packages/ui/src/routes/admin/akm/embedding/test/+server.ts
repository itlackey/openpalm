import type { RequestHandler } from './$types';
import { testEmbeddingSettings } from '$lib/server/akm.js';
import { errorResponse, getRequestId, jsonBodyError, parseJsonBody, jsonResponse, requireAdmin } from '$lib/server/helpers.js';

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const parsed = await parseJsonBody(event.request);
  if ('error' in parsed) return jsonBodyError(parsed, requestId);

  const body = parsed.data;
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  const model = typeof body.model === 'string' ? body.model : '';
  const provider = typeof body.provider === 'string' ? body.provider : '';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
  const dimension = typeof body.dimension === 'number' ? body.dimension : undefined;

  if (!endpoint.trim() || !model.trim()) {
    return errorResponse(400, 'bad_request', 'Endpoint and model are required.', {}, requestId);
  }

  const result = await testEmbeddingSettings({ endpoint, model, provider, apiKey, dimension });
  if (!result.ok) {
    return errorResponse(502, 'embedding_test_failed', result.message, {}, requestId);
  }

  return jsonResponse(200, result, requestId);
};
