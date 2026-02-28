/**
 * GET /admin/audit — Read audit log entries.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import { jsonResponse, requireAdmin, getRequestId, getActor, getCallerType } from "$lib/server/helpers.js";
import { appendAudit } from "$lib/server/control-plane.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const url = new URL(event.request.url);
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = rawLimit > 0 ? rawLimit : state.audit.length;

  appendAudit(state, actor, "audit.list", {}, true, requestId, callerType);
  return jsonResponse(200, { audit: state.audit.slice(-limit) }, requestId);
};
