import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  requireCapability,
} from "$lib/server/helpers.js";
import { getDockerEvents, checkDocker } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:containers', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const since = event.url.searchParams.get("since") || "1h";

  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    return errorResponse(503, "docker_unavailable", "Docker is not available", {}, requestId);
  }

  const result = await getDockerEvents("openpalm", since);

  if (!result.ok) {
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
    } catch (e) {
      console.warn('[containers.events] Failed to parse Docker events output', e);
      return errorResponse(500, "parse_error", "Failed to parse Docker events output", {}, requestId);
    }
  }

  return jsonResponse(200, { events }, requestId);
};
