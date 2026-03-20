import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAuth,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { appendAudit } from "$lib/server/control-plane.js";
import { getDockerEvents, checkDocker } from "$lib/server/docker.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAuth(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const since = event.url.searchParams.get("since") || "1h";

  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    appendAudit(state, actor, "containers.events", { since }, false, requestId, callerType);
    return errorResponse(503, "docker_unavailable", "Docker is not available", {}, requestId);
  }

  const result = await getDockerEvents("openpalm", since);

  if (!result.ok) {
    appendAudit(state, actor, "containers.events", { since, error: result.stderr }, false, requestId, callerType);
    return errorResponse(500, "docker_error", `Failed to get Docker events: ${result.stderr}`, {}, requestId);
  }

  let events: unknown[] = [];
  if (result.stdout.trim()) {
    try {
      events = result.stdout
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l));
    } catch {
      appendAudit(state, actor, "containers.events", { since, error: "Failed to parse events output" }, false, requestId, callerType);
      return errorResponse(500, "parse_error", "Failed to parse Docker events output", {}, requestId);
    }
  }

  appendAudit(state, actor, "containers.events", { since }, true, requestId, callerType);

  return jsonResponse(200, { events }, requestId);
};
