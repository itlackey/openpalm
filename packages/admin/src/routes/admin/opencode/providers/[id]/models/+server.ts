import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, getRequestId } from '$lib/server/helpers.js';
import { proxyToOpenCode } from '$lib/opencode/client.server.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const providerId = event.params.id;
  const result = await proxyToOpenCode('/provider');
  if (!result.ok) {
    return jsonResponse(200, { models: [] }, requestId);
  }

  const data = result.data as { all?: Array<{ id: string; models?: Record<string, unknown> }> };
  const provider = data.all?.find((p) => p.id === providerId);
  if (!provider || !provider.models) {
    return jsonResponse(200, { models: [] }, requestId);
  }

  const models = Object.values(provider.models).map((m) => {
    const model = m as Record<string, unknown>;
    return {
      id: model.id,
      name: model.name ?? model.id,
      family: model.family ?? '',
      providerID: model.providerID ?? providerId,
      status: model.status ?? 'active',
      capabilities: model.capabilities ?? {},
      cost: model.cost ?? {},
      limit: model.limit ?? {},
    };
  });

  return jsonResponse(200, { models }, requestId);
};
