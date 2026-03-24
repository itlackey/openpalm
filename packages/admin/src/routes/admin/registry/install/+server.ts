/**
 * POST /admin/registry/install — Install a registry item (automation only).
 *
 * Channel addons are managed via POST /admin/addons/:name.
 * This endpoint only handles automations from the registry.
 *
 * Tries the cloned registry repo first, falls back to on-disk automations.
 * Delegates filesystem operations to installAutomationFromRegistry() from lib.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType,
  parseJsonBody
} from "$lib/server/helpers.js";
import {
  appendAudit,
  installAutomationFromRegistry,
  writeRuntimeFiles,
  resolveRuntimeFiles,
  buildMergedRegistry,
} from "@openpalm/lib";


export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, "invalid_input", "Request body must be valid JSON", {}, requestId);
  }
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

  // Build a merged registry: remote (cloned repo) automations take precedence over local disk
  const registry = buildMergedRegistry(state.homeDir, state.configDir);

  const result = installAutomationFromRegistry(name, state.configDir, registry);
  if (!result.ok) {
    appendAudit(state, actor, "registry.install", { name, type, error: result.error }, false, requestId, callerType);
    return errorResponse(400, "invalid_input", result.error, {}, requestId);
  }

  state.artifacts = resolveRuntimeFiles(state);
  writeRuntimeFiles(state);
  // Scheduler sidecar auto-reloads via file watching

  appendAudit(state, actor, "registry.install", { name, type }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, name, type }, requestId);
};
