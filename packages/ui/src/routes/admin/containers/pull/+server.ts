import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { withSerialQueue } from "$lib/server/serial-queue.js";
import { buildComposeOptions, buildManagedServices, createLogger } from "@openpalm/lib";
import { applyStack, checkDocker } from "@openpalm/lib";
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

    logger.info("pulling and recreating containers", { requestId });
    const managedServices = await buildManagedServices(state);
    // The single compose driver (§4.3, plan 2.2). `pull: "always"` is what this
    // manual button is FOR: force a fresh pull even when the tag is unchanged
    // (an updated :latest, or a re-pulled :vX.Y.Z) — a plain `up` would keep the
    // OLD image (the akm-0.3.1 surprise). --force-recreate (always on in
    // applyStack) then swaps the running container onto the freshly pulled image.
    const result = await applyStack({ kind: "services", services: managedServices }, composeOpts, undefined, { pull: "always" });
    if (!result.ok) {
      logger.error("pull/recreate failed", { requestId, error: result.error });
      return errorResponse(502, "up_failed", "Failed to pull and recreate containers", { stderr: result.rawStderr ?? result.error ?? "" }, requestId);
    }

    logger.info("pull completed", { requestId, started: result.started });

    return jsonResponse(200, {
      ok: true,
      started: result.started
    }, requestId);
  });
};
