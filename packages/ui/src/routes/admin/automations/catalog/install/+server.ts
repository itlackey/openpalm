/**
 * POST /admin/automations/catalog/install — Install a catalog automation.
 *
 * Copies the markdown task file from the registry catalog to stash/tasks/.
 * The assistant container's 60-second akm tasks sync loop picks up the new
 * file from the shared /akm/tasks/ mount and registers it with OS cron.
 */
import type { RequestHandler } from "@sveltejs/kit";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType,
  parseJsonBody,
  jsonBodyError
} from "$lib/server/helpers.js";
import {
  appendAudit,
  installAutomationFromRegistry,
} from "@openpalm/lib";


export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const parsed = await parseJsonBody(event.request);
  if ('error' in parsed) return jsonBodyError(parsed, requestId);
  const body = parsed.data;
  const name = body.name as string | undefined;
  const type = body.type as string | undefined;

  if (!name || typeof name !== "string") {
    return errorResponse(400, "invalid_input", "name is required and must be valid", {}, requestId);
  }

  if (type === "channel") {
    return errorResponse(400, "invalid_input", "Channel addons are managed via POST /admin/addons/:name. Use the addon system.", {}, requestId);
  }

  if (type !== "automation") {
    return errorResponse(400, "invalid_input", "type must be 'automation'", {}, requestId);
  }

  const result = installAutomationFromRegistry(name, state.stashDir);
  if (!result.ok) {
    appendAudit(state, actor, "automations.catalog.install", { name, type, error: result.error }, false, requestId, callerType);
    return errorResponse(400, "invalid_input", result.error, {}, requestId);
  }

  appendAudit(state, actor, "automations.catalog.install", { name, type }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, name, type }, requestId);
};
