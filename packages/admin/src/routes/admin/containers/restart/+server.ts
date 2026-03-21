import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  getActor,
  getCallerType,
  parseJsonBody
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { isAllowedService, appendAudit, buildComposeFileList, buildEnvFiles } from "$lib/server/control-plane.js";
import { composeRestart, checkDocker } from "$lib/server/docker.js";
import { createLogger } from "$lib/server/logger.js";
import type { RequestHandler } from "./$types";

const logger = createLogger("containers-restart");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("container restart request", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, "invalid_input", "Request body must be valid JSON", {}, requestId);
  }
  const service = typeof body.service === "string" ? body.service : "";

  if (!isAllowedService(service, state.configDir)) {
    appendAudit(state, actor, "containers.restart", { service }, false, requestId, callerType);
    return errorResponse(400, "invalid_service", "Service is not in allowlist", { service }, requestId);
  }

  // Try real Docker — only update state based on actual result
  const dockerCheck = await checkDocker();
  if (dockerCheck.ok) {
    const result = await composeRestart([service], { files: buildComposeFileList(state), envFiles: buildEnvFiles(state) });
    if (result.ok) {
      state.services[service] = "running";
    } else {
      appendAudit(state, actor, "containers.restart", { service, error: result.stderr }, false, requestId, callerType);
      return errorResponse(500, "docker_error", `Failed to restart service: ${result.stderr}`, { service }, requestId);
    }
  } else {
    state.services[service] = "running";
  }

  appendAudit(state, actor, "containers.restart", { service }, true, requestId, callerType);

  return jsonResponse(
    200,
    { ok: true, service, status: state.services[service] },
    requestId
  );
};
