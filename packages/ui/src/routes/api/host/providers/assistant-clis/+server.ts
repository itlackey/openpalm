import type { RequestHandler } from './$types';
import { getRequestId, jsonResponse, requireAdmin, requireCapability } from '$lib/server/helpers.js';
import { getState } from '$lib/server/state.js';
import { listAssistantCliTools } from '@openpalm/lib';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:secrets', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  return jsonResponse(200, { tools: listAssistantCliTools(getState()) }, requestId);
};
