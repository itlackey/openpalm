/**
 * POST /admin/automations/catalog/refresh — Refresh the runtime catalog from GitHub.
 */
import type { RequestHandler } from "@sveltejs/kit";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import {
  appendAudit,
  refreshRegistryCatalog
} from "@openpalm/lib";


export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  try {
    const result = refreshRegistryCatalog();
    appendAudit(state, actor, "automations.catalog.refresh", { root: result.root }, true, requestId, callerType);
    return jsonResponse(200, { ok: true, root: result.root }, requestId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendAudit(state, actor, "automations.catalog.refresh", { error: message }, false, requestId, callerType);
    return errorResponse(500, "registry_sync_error", message, {}, requestId);
  }
};
