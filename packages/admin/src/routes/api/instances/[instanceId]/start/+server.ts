/**
 * POST /api/instances/:instanceId/start — Start an instance container.
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
  installCaddyRoute,
  buildComposeFileList,
  buildEnvFiles,
} from "$lib/server/control-plane.js";
import { composeStart, checkDocker, caddyReload } from "$lib/server/docker.js";
import { createLogger } from "$lib/server/logger.js";

const logger = createLogger("api-instance-start");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("instance start request", { requestId });
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const instanceId = event.params.instanceId;

  const detail = getInstanceDetail(state.homeDir, instanceId);
  if (!detail) {
    appendAudit(state, actor, "instances.start", { instanceId }, false, requestId, callerType);
    return errorResponse(404, "not_found", `Instance "${instanceId}" not found`, { instanceId }, requestId);
  }

  const containerName = `openpalm-${instanceId}`;

  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    appendAudit(state, actor, "instances.start", { instanceId, error: "docker_unavailable" }, false, requestId, callerType);
    return errorResponse(503, "docker_unavailable", "Docker is not available", {}, requestId);
  }

  // Install Caddy route if the component has a .caddy file
  const caddyInstalled = installCaddyRoute(state.homeDir, instanceId);

  const result = await composeStart(state.configDir, [containerName], {
    files: buildComposeFileList(state),
    envFiles: buildEnvFiles(state),
  });

  if (!result.ok) {
    appendAudit(state, actor, "instances.start", { instanceId, error: result.stderr }, false, requestId, callerType);
    return errorResponse(500, "docker_error", `Failed to start instance: ${result.stderr}`, { instanceId }, requestId);
  }

  // Reload Caddy if a route was installed
  if (caddyInstalled) {
    await caddyReload(state.configDir, {
      files: buildComposeFileList(state),
      envFiles: buildEnvFiles(state),
    }).catch((err) => {
      logger.warn("caddy reload failed after start", { requestId, instanceId, error: String(err) });
    });
  }

  state.services[containerName] = "running";

  appendAudit(state, actor, "instances.start", { instanceId }, true, requestId, callerType);
  logger.info("instance started", { requestId, instanceId });
  return jsonResponse(200, { ok: true, instanceId, status: "running", requestId }, requestId);
};
