/**
 * GET /api/instances/:instanceId/health — Health check for an instance.
 *
 * If the component has an openpalm.healthcheck label, probes the healthcheck
 * URL on the Docker internal network. Otherwise, falls back to container
 * running status.
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
  discoverComponents,
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
    appendAudit(state, actor, "instances.health", { instanceId }, false, requestId, callerType);
    return errorResponse(404, "not_found", `Instance "${instanceId}" not found`, { instanceId }, requestId);
  }

  // Look up healthcheck URL from the component definition
  const components = discoverComponents(state.homeDir);
  const componentDef = components.find((c) => c.id === detail.component);
  const healthcheckUrl = componentDef?.labels.healthcheck;

  let healthy = false;
  let checkedVia: "healthcheck" | "status" = "status";

  if (healthcheckUrl) {
    checkedVia = "healthcheck";
    try {
      const res = await fetch(healthcheckUrl, {
        signal: AbortSignal.timeout(5000),
      });
      healthy = res.ok;
    } catch {
      healthy = false;
    }
  } else {
    // Fallback: check if the container is marked as running in state
    const containerName = `openpalm-${instanceId}`;
    healthy = state.services[containerName] === "running";
  }

  appendAudit(state, actor, "instances.health", { instanceId, healthy }, true, requestId, callerType);
  return jsonResponse(200, {
    instanceId,
    healthy,
    checkedVia,
    requestId,
  }, requestId);
};
