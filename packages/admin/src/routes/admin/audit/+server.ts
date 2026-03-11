/**
 * GET /admin/audit — Read audit log entries.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import { jsonResponse, requireAdmin, getRequestId } from "$lib/server/helpers.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const url = new URL(event.request.url);
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Math.min(rawLimit > 0 ? rawLimit : state.audit.length, 1000);

  return jsonResponse(200, { audit: state.audit.slice(-limit) }, requestId);
};
