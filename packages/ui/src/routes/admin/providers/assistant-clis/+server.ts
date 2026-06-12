import type { RequestHandler } from './$types';
import { getRequestId, jsonResponse, requireAdmin } from '$lib/server/helpers.js';
import { getState } from '$lib/server/state.js';
import { listAssistantCliTools } from '@openpalm/lib';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  return jsonResponse(200, { tools: listAssistantCliTools(getState()) }, requestId);
};
