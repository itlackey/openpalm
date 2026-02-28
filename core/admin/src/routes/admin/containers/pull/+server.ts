import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { appendAudit, buildComposeFileList, buildEnvFiles } from "$lib/server/control-plane.js";
import { composePull, composeUp, checkDocker } from "$lib/server/docker.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
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

  const pullResult = await composePull(state.stateDir, { files, envFiles });
  if (!pullResult.ok) {
    appendAudit(state, actor, "containers.pull", { result: "error", reason: "pull_failed", stderr: pullResult.stderr }, false, requestId, callerType);
    return errorResponse(502, "pull_failed", "Failed to pull images", { stderr: pullResult.stderr }, requestId);
  }

  const upResult = await composeUp(state.stateDir, { files, envFiles });
  if (!upResult.ok) {
    appendAudit(state, actor, "containers.pull", { result: "error", reason: "up_failed", stderr: upResult.stderr }, false, requestId, callerType);
    return errorResponse(502, "up_failed", "Images pulled but failed to recreate containers", { stderr: upResult.stderr }, requestId);
  }

  appendAudit(state, actor, "containers.pull", { result: "ok" }, true, requestId, callerType);

  return jsonResponse(
    200,
    { ok: true, pulled: pullResult.stdout, started: upResult.stdout },
    requestId
  );
};
