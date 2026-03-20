/**
 * GET /api/components/:componentId — Component detail including labels and schema.
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
} from "$lib/server/helpers.js";
import {
  appendAudit,
  discoverComponents,
  parseEnvSchema,
} from "$lib/server/control-plane.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const componentId = event.params.componentId;

  const defs = discoverComponents(state.homeDir);
  const component = defs.find((c) => c.id === componentId);

  if (!component) {
    appendAudit(state, actor, "components.detail", { componentId }, false, requestId, callerType);
    return errorResponse(404, "not_found", `Component "${componentId}" not found`, { componentId }, requestId);
  }

  const schema = parseEnvSchema(component.schemaPath);

  appendAudit(state, actor, "components.detail", { componentId }, true, requestId, callerType);
  return jsonResponse(200, {
    id: component.id,
    source: component.source,
    labels: component.labels,
    schema,
    hasCaddy: component.caddyPath !== null,
    requestId,
  }, requestId);
};
