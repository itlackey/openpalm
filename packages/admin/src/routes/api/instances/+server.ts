/**
 * GET  /api/instances — List all component instances.
 * POST /api/instances — Create a new component instance.
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
  parseJsonBody,
} from "$lib/server/helpers.js";
import {
  appendAudit,
  listInstances,
  createInstance,
  discoverComponents,
} from "@openpalm/lib";
import { createLogger } from "$lib/server/logger.js";
import type { InstanceResponse } from "$lib/types.js";

const logger = createLogger("api-instances");

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const details = listInstances(state.homeDir);
  const components = discoverComponents(state.homeDir);
  const componentMap = new Map(components.map((c) => [c.id, c]));
  const instances: InstanceResponse[] = details.map((d) => ({
    id: d.id,
    component: d.component,
    enabled: d.enabled,
    status: d.status,
    category: componentMap.get(d.component)?.labels.category,
    instanceDir: d.instanceDir,
  }));

  appendAudit(state, actor, "instances.list", {}, true, requestId, callerType);
  return jsonResponse(200, { instances, requestId }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("create instance request", { requestId });
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, "invalid_input", "Request body must be valid JSON", {}, requestId);
  }

  if (typeof body.component !== "string" || typeof body.name !== "string") {
    return errorResponse(400, "invalid_input", "component and name must be strings", {}, requestId);
  }

  const component = body.component.trim();
  const name = body.name.trim();

  if (!component) {
    return errorResponse(400, "missing_field", "component is required", {}, requestId);
  }
  if (!name) {
    return errorResponse(400, "missing_field", "name is required (used as instance ID)", {}, requestId);
  }

  // Resolve component definition
  const defs = discoverComponents(state.homeDir);
  const componentDef = defs.find((c) => c.id === component);
  if (!componentDef) {
    appendAudit(state, actor, "instances.create", { component, name }, false, requestId, callerType);
    return errorResponse(404, "component_not_found", `Component "${component}" not found`, { component }, requestId);
  }

  try {
    const detail = createInstance(state.homeDir, componentDef, name);
    const instance: InstanceResponse = {
      id: detail.id,
      component: detail.component,
      enabled: detail.enabled,
      status: detail.status,
      category: componentDef.labels.category,
      instanceDir: detail.instanceDir,
    };

    appendAudit(state, actor, "instances.create", { component, name }, true, requestId, callerType);
    logger.info("instance created", { requestId, instanceId: name, component });
    return jsonResponse(201, { instance, requestId }, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendAudit(state, actor, "instances.create", { component, name, error: message }, false, requestId, callerType);
    logger.warn("instance creation failed", { requestId, component, name, error: message });

    // Distinguish validation errors from internal errors
    if (message.includes("Invalid instance ID") || message.includes("reserved") || message.includes("already exists")) {
      return errorResponse(409, "conflict", message, { component, name }, requestId);
    }
    return errorResponse(500, "create_failed", message, { component, name }, requestId);
  }
};
