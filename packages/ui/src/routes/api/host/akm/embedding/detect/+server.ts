import type { RequestHandler } from './$types';
import { detectEmbeddingSettings } from '$lib/server/akm.js';
import { getState } from '$lib/server/state.js';
import { errorResponse, getRequestId, jsonResponse, requireAdmin, requireCapability } from '$lib/server/helpers.js';

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:stack:read', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const detected = await detectEmbeddingSettings(getState());
  if (!detected.ok) {
    return errorResponse(404, 'embedding_not_detected', detected.message, {}, requestId);
  }

  return jsonResponse(200, detected, requestId);
};
