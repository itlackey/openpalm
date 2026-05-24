import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { withSerialQueue } from "$lib/server/serial-queue.js";
import { buildComposeOptions, buildManagedServices, createLogger } from "@openpalm/lib";
import { composePull, composeUp, checkDocker } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("containers-pull");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("pull request received", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  return withSerialQueue("admin:containers:pull", async () => {
    const state = getState();

    const dockerCheck = await checkDocker();
    if (!dockerCheck.ok) {
      return errorResponse(503, "docker_unavailable", "Docker is not available", { stderr: dockerCheck.stderr }, requestId);
    }

    const composeOpts = buildComposeOptions(state);

    logger.info("pulling images", { requestId });
    const pullResult = await composePull(composeOpts);
    if (!pullResult.ok) {
      logger.error("image pull failed", { requestId, stderr: pullResult.stderr });
      return errorResponse(502, "pull_failed", "Failed to pull images", { stderr: pullResult.stderr }, requestId);
    }

    logger.info("recreating containers", { requestId });
    const managedServices = await buildManagedServices(state);
    const upResult = await composeUp({ ...composeOpts, services: managedServices });
    if (!upResult.ok) {
      logger.error("compose up failed after pull", { requestId, stderr: upResult.stderr });
      return errorResponse(502, "up_failed", "Images pulled but failed to recreate containers", { stderr: upResult.stderr }, requestId);
    }

    logger.info("pull completed", { requestId, started: managedServices });

    return jsonResponse(200, {
      ok: true,
      pulled: pullResult.stdout,
      started: managedServices
    }, requestId);
  });
};
