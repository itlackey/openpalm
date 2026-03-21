import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { appendAudit, buildComposeFileList, buildEnvFiles, buildManagedServices } from "$lib/server/control-plane.js";
import { composePull, composeUp, checkDocker } from "$lib/server/docker.js";
import { createLogger } from "$lib/server/logger.js";
import type { RequestHandler } from "./$types";

const logger = createLogger("containers-pull");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("pull request received", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    appendAudit(state, actor, "containers.pull", { result: "error", reason: "docker_unavailable" }, false, requestId, callerType);
    return errorResponse(503, "docker_unavailable", "Docker is not available", { stderr: dockerCheck.stderr }, requestId);
  }

  const files = buildComposeFileList(state);
  const envFiles = buildEnvFiles(state);

  logger.info("pulling images", { requestId });
  const pullResult = await composePull({ files, envFiles });
  if (!pullResult.ok) {
    logger.error("image pull failed", { requestId, stderr: pullResult.stderr });
    appendAudit(state, actor, "containers.pull", { result: "error", reason: "pull_failed", stderr: pullResult.stderr }, false, requestId, callerType);
    return errorResponse(502, "pull_failed", "Failed to pull images", { stderr: pullResult.stderr }, requestId);
  }

  logger.info("recreating containers", { requestId });
  const managedServices = await buildManagedServices(state);
  const upResult = await composeUp({ files, envFiles, services: managedServices });
  if (!upResult.ok) {
    logger.error("compose up failed after pull", { requestId, stderr: upResult.stderr });
    appendAudit(state, actor, "containers.pull", { result: "error", reason: "up_failed", stderr: upResult.stderr }, false, requestId, callerType);
    return errorResponse(502, "up_failed", "Images pulled but failed to recreate containers", { stderr: upResult.stderr }, requestId);
  }

  appendAudit(state, actor, "containers.pull", { result: "ok", started: managedServices }, true, requestId, callerType);
  logger.info("pull completed", { requestId, started: managedServices });

  return jsonResponse(200, {
    ok: true,
    pulled: pullResult.stdout,
    started: managedServices
  }, requestId);
};
