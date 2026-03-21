/**
 * POST /api/instances/:instanceId/restart — Restart an instance container.
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
  buildComposeFileList,
  buildEnvFiles,
} from "$lib/server/control-plane.js";
import { composeRestart, checkDocker } from "$lib/server/docker.js";
import { createLogger } from "$lib/server/logger.js";

const logger = createLogger("api-instance-restart");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("instance restart request", { requestId });
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const instanceId = event.params.instanceId;

  const detail = getInstanceDetail(state.homeDir, instanceId);
  if (!detail) {
    appendAudit(state, actor, "instances.restart", { instanceId }, false, requestId, callerType);
    return errorResponse(404, "not_found", `Instance "${instanceId}" not found`, { instanceId }, requestId);
  }

  const containerName = `openpalm-${instanceId}`;

  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    appendAudit(state, actor, "instances.restart", { instanceId, error: "docker_unavailable" }, false, requestId, callerType);
    return errorResponse(503, "docker_unavailable", "Docker is not available", {}, requestId);
  }

  const result = await composeRestart([containerName], {
    files: buildComposeFileList(state),
    envFiles: buildEnvFiles(state),
  });

  if (!result.ok) {
    appendAudit(state, actor, "instances.restart", { instanceId, error: result.stderr }, false, requestId, callerType);
    return errorResponse(500, "docker_error", `Failed to restart instance: ${result.stderr}`, { instanceId }, requestId);
  }

  state.services[containerName] = "running";

  appendAudit(state, actor, "instances.restart", { instanceId }, true, requestId, callerType);
  logger.info("instance restarted", { requestId, instanceId });
  return jsonResponse(200, { ok: true, instanceId, status: "running", requestId }, requestId);
};
