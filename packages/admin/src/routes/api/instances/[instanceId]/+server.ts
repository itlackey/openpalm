/**
 * GET    /api/instances/:instanceId — Instance detail with config and status.
 * PUT    /api/instances/:instanceId — Update instance .env configuration.
 * DELETE /api/instances/:instanceId — Delete (archive) an instance.
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
  getInstanceDetail,
  configureInstance,
  deleteInstance,
} from "$lib/server/control-plane.js";
import { composeStop, checkDocker } from "$lib/server/docker.js";
import { createLogger } from "$lib/server/logger.js";

const logger = createLogger("api-instance-detail");

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const instanceId = event.params.instanceId;

  const detail = getInstanceDetail(state.homeDir, instanceId);
  if (!detail) {
    appendAudit(state, actor, "instances.detail", { instanceId }, false, requestId, callerType);
    return errorResponse(404, "not_found", `Instance "${instanceId}" not found`, { instanceId }, requestId);
  }

  appendAudit(state, actor, "instances.detail", { instanceId }, true, requestId, callerType);
  return jsonResponse(200, { instance: detail, requestId }, requestId);
};

export const PUT: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("configure instance request", { requestId });
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const instanceId = event.params.instanceId;

  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, "invalid_input", "Request body must be valid JSON", {}, requestId);
  }

  const values = body.values;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return errorResponse(400, "invalid_input", "values must be a key-value object", {}, requestId);
  }

  // Validate all values are strings
  for (const [key, val] of Object.entries(values as Record<string, unknown>)) {
    if (typeof val !== "string") {
      return errorResponse(400, "invalid_input", `Value for "${key}" must be a string`, {}, requestId);
    }
  }

  try {
    configureInstance(state.homeDir, instanceId, values as Record<string, string>);
    appendAudit(state, actor, "instances.configure", { instanceId, keys: Object.keys(values as Record<string, unknown>) }, true, requestId, callerType);
    logger.info("instance configured", { requestId, instanceId });
    return jsonResponse(200, { ok: true, requestId }, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendAudit(state, actor, "instances.configure", { instanceId, error: message }, false, requestId, callerType);

    if (message.includes("does not exist")) {
      return errorResponse(404, "not_found", message, { instanceId }, requestId);
    }
    return errorResponse(500, "configure_failed", message, { instanceId }, requestId);
  }
};

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("delete instance request", { requestId });
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const instanceId = event.params.instanceId;

  // Verify instance exists before attempting deletion
  const detail = getInstanceDetail(state.homeDir, instanceId);
  if (!detail) {
    appendAudit(state, actor, "instances.delete", { instanceId }, false, requestId, callerType);
    return errorResponse(404, "not_found", `Instance "${instanceId}" not found`, { instanceId }, requestId);
  }

  // Best-effort stop the container before deletion
  const dockerCheck = await checkDocker();
  if (dockerCheck.ok) {
    const containerName = `openpalm-${instanceId}`;
    await composeStop(state.configDir, [containerName]).catch((err) => {
      logger.warn("failed to stop container before delete", {
        requestId,
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  try {
    deleteInstance(state.homeDir, instanceId);
    appendAudit(state, actor, "instances.delete", { instanceId }, true, requestId, callerType);
    logger.info("instance deleted", { requestId, instanceId });
    return jsonResponse(200, { ok: true, requestId }, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendAudit(state, actor, "instances.delete", { instanceId, error: message }, false, requestId, callerType);
    return errorResponse(500, "delete_failed", message, { instanceId }, requestId);
  }
};
