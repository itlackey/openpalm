/**
 * GET /api/instances/:instanceId/schema — Parse and return instance .env.schema as JSON.
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
  getInstanceDetail,
  parseEnvSchema,
} from "@openpalm/lib";

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
    appendAudit(state, actor, "instances.schema", { instanceId }, false, requestId, callerType);
    return errorResponse(404, "not_found", `Instance "${instanceId}" not found`, { instanceId }, requestId);
  }

  const schema = parseEnvSchema(detail.schemaPath);

  appendAudit(state, actor, "instances.schema", { instanceId }, true, requestId, callerType);
  return jsonResponse(200, { schema, requestId }, requestId);
};
