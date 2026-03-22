import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAuth,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { appendAudit, buildComposeFileList, buildEnvFiles } from "@openpalm/lib";
import { composeStats, checkDocker } from "$lib/server/docker.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAuth(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    appendAudit(state, actor, "containers.stats", {}, false, requestId, callerType);
    return errorResponse(503, "docker_unavailable", "Docker is not available", {}, requestId);
  }

  const result = await composeStats({
    files: buildComposeFileList(state),
    envFiles: buildEnvFiles(state)
  });

  if (!result.ok) {
    appendAudit(state, actor, "containers.stats", { error: result.stderr }, false, requestId, callerType);
    return errorResponse(500, "docker_error", `Failed to get container stats: ${result.stderr}`, {}, requestId);
  }

  let stats: unknown[] = [];
  if (result.stdout.trim()) {
    try {
      stats = result.stdout
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l));
    } catch {
      appendAudit(state, actor, "containers.stats", { error: "Failed to parse stats output" }, false, requestId, callerType);
      return errorResponse(500, "parse_error", "Failed to parse Docker stats output", {}, requestId);
    }
  }

  appendAudit(state, actor, "containers.stats", {}, true, requestId, callerType);

  return jsonResponse(200, { stats }, requestId);
};
