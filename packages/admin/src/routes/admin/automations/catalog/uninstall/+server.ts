/**
 * POST /admin/automations/catalog/uninstall — Uninstall a catalog automation.
 *
 * Channel addons are managed via POST /admin/addons/:name.
 * This endpoint only handles automations.
 *
 * Removes the .yml from CONFIG_HOME/automations/,
 * refreshes runtime files, and reloads the scheduler.
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
  uninstallAutomation,
  writeRuntimeFiles,
  resolveRuntimeFiles,
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
    return errorResponse(400, "invalid_input", "name is required", {}, requestId);
  }

  if (type === "channel") {
    return errorResponse(400, "invalid_input", "Channel addons are managed via POST /admin/addons/:name. Use the addon system.", {}, requestId);
  }

  if (type !== "automation") {
    return errorResponse(400, "invalid_input", "type must be 'automation'", {}, requestId);
  }

  // type === "automation"
  const result = uninstallAutomation(name, state.configDir);
  if (!result.ok) {
    appendAudit(state, actor, "automations.catalog.uninstall", { name, type, error: result.error }, false, requestId, callerType);
    return errorResponse(400, "invalid_input", result.error, {}, requestId);
  }

  state.artifacts = resolveRuntimeFiles();
  writeRuntimeFiles(state);
  // Scheduler sidecar auto-reloads via file watching

  appendAudit(state, actor, "automations.catalog.uninstall", { name, type }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, name, type }, requestId);
};
