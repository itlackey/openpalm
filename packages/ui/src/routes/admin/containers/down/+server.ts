import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  parseJsonBody,
  jsonBodyError
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { isAllowedService, buildComposeOptions, createLogger } from "@openpalm/lib";
import { composeStop, checkDocker } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("containers-down");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("container stop request", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

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
    const result = await composeStop([service], buildComposeOptions(state));
    if (result.ok) {
      state.services[service] = "stopped";
    } else {
      return errorResponse(500, "docker_error", `Failed to stop service: ${result.stderr}`, { service }, requestId);
    }
  } else {
    state.services[service] = "stopped";
  }

  return jsonResponse(
    200,
    { ok: true, service, status: state.services[service] },
    requestId
  );
};
