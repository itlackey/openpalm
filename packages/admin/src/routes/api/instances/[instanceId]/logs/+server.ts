/**
 * GET /api/instances/:instanceId/logs — Retrieve container logs for an instance.
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
import { composeLogs, checkDocker } from "$lib/server/docker.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const instanceId = event.params.instanceId;

  const detail = getInstanceDetail(state.homeDir, instanceId);
  if (!detail) {
    appendAudit(state, actor, "instances.logs", { instanceId }, false, requestId, callerType);
    return errorResponse(404, "not_found", `Instance "${instanceId}" not found`, { instanceId }, requestId);
  }

  const url = new URL(event.request.url);
  const tailParam = url.searchParams.get("tail");
  const sinceParam = url.searchParams.get("since");

  const tail = tailParam ? Number(tailParam) : 100;
  if (tailParam && (!Number.isInteger(tail) || tail < 1 || tail > 10000)) {
    return errorResponse(400, "invalid_parameter", "tail must be an integer between 1 and 10000", {}, requestId);
  }

  if (sinceParam && !/^[a-zA-Z0-9.:+\-T]+$/.test(sinceParam)) {
    return errorResponse(400, "invalid_parameter", "since contains invalid characters", {}, requestId);
  }

  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    appendAudit(state, actor, "instances.logs", { instanceId, error: "docker_unavailable" }, false, requestId, callerType);
    return errorResponse(503, "docker_unavailable", "Docker is not available", {}, requestId);
  }

  const containerName = `openpalm-${instanceId}`;
  const result = await composeLogs(state.configDir, [containerName], tail, {
    files: buildComposeFileList(state),
    envFiles: buildEnvFiles(state),
    since: sinceParam ?? undefined,
  });

  appendAudit(state, actor, "instances.logs", { instanceId, tail }, result.ok, requestId, callerType);

  if (!result.ok) {
    return jsonResponse(500, { ok: false, logs: "", error: result.stderr, requestId }, requestId);
  }

  const logs = (result.stdout + result.stderr).trim();
  return jsonResponse(200, { ok: true, logs, requestId }, requestId);
};
