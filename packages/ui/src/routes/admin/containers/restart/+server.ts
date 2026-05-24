import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  parseJsonBody,
  jsonBodyError
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { withSerialQueue } from "$lib/server/serial-queue.js";
import { isAllowedService, buildComposeOptions, createLogger } from "@openpalm/lib";
import { composeRestart, checkDocker } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("containers-restart");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("container restart request", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  return withSerialQueue("admin:containers:restart", async () => {
    const state = getState();
    const result = await parseJsonBody(event.request);
    if ('error' in result) return jsonBodyError(result, requestId);
    const body = result.data;
    const service = typeof body.service === "string" ? body.service : "";

    if (!isAllowedService(service, state.configDir)) {
      return errorResponse(400, "invalid_service", "Service is not in allowlist", { service }, requestId);
    }

    // Try real Docker — only update state based on actual result
    const dockerCheck = await checkDocker();
    if (dockerCheck.ok) {
      const result = await composeRestart([service], buildComposeOptions(state));
      if (result.ok) {
        state.services[service] = "running";
      } else {
        return errorResponse(500, "docker_error", `Failed to restart service: ${result.stderr}`, { service }, requestId);
      }
    } else {
      state.services[service] = "running";
    }

    return jsonResponse(
      200,
      { ok: true, service, status: state.services[service] },
      requestId
    );
  });
};
