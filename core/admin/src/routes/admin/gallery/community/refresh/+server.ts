/**
 * POST /admin/gallery/community/refresh — Refresh community extension list.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import { jsonResponse, requireAdmin, getRequestId, getActor, getCallerType } from "$lib/server/helpers.js";
import { appendAudit } from "$lib/server/control-plane.js";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  appendAudit(state, actor, "gallery.refresh", {}, true, requestId, callerType);
  return jsonResponse(200, { ok: true, refreshedAt: new Date().toISOString() }, requestId);
};
