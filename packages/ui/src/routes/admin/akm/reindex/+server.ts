import type { RequestHandler } from './$types';
import { runAkmCommand } from '$lib/server/akm.js';
import { getState } from '$lib/server/state.js';
import { errorResponse, getRequestId, jsonResponse, requireAdmin } from '$lib/server/helpers.js';

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const result = await runAkmCommand(getState(), ['index', '--full'], 15 * 60_000);
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || 'AKM re-index failed.';
    return errorResponse(502, 'akm_reindex_failed', detail, {}, requestId);
  }

  return jsonResponse(200, {
    ok: true,
    message: 'AKM index rebuilt successfully.',
    output: result.stdout.trim(),
  }, requestId);
};
