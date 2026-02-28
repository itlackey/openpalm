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
import { composeStop, checkDocker } from "$lib/server/docker.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const body = await parseJsonBody(event.request);
  const service = String(body.service ?? "");

  if (!isAllowedService(service, state.stateDir)) {
    appendAudit(state, actor, "containers.down", { service }, false, requestId, callerType);
    return errorResponse(400, "invalid_service", "Service is not in allowlist", { service }, requestId);
  }

  state.services[service] = "stopped";

  const dockerCheck = await checkDocker();
  if (dockerCheck.ok) {
    await composeStop(state.stateDir, [service], { files: buildComposeFileList(state), envFiles: buildEnvFiles(state) });
  }

  appendAudit(state, actor, "containers.down", { service }, true, requestId, callerType);

  return jsonResponse(
    200,
    { ok: true, service, status: state.services[service] },
    requestId
  );
};
