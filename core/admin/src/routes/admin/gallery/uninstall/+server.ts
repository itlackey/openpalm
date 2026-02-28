/**
 * POST /admin/gallery/uninstall — Uninstall an extension.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import { jsonResponse, errorResponse, requireAdmin, getRequestId, getActor, getCallerType, parseJsonBody } from "$lib/server/helpers.js";
import { appendAudit } from "$lib/server/control-plane.js";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const body = await parseJsonBody(event.request);
  const id = String(body.galleryId ?? body.pluginId ?? "");

  if (!id) {
    appendAudit(state, actor, "extensions.uninstall", {}, false, requestId, callerType);
    return errorResponse(400, "invalid_input", "galleryId or pluginId is required", {}, requestId);
  }

  state.installedExtensions.delete(id);
  appendAudit(state, actor, "extensions.uninstall", { id }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, id }, requestId);
};
