/**
 * GET /admin/logs — Retrieve docker compose service logs.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAuth,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { appendAudit, buildComposeFileList, buildEnvFiles, isAllowedService } from "@openpalm/lib";
import { composeLogs, checkDocker } from "$lib/server/docker.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAuth(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const url = new URL(event.request.url);

  // Parse query parameters
  const serviceParam = url.searchParams.get("service");
  const tailParam = url.searchParams.get("tail");
  const sinceParam = url.searchParams.get("since");

  // Parse and validate tail
  const tail = tailParam ? Number(tailParam) : 100;
  if (tailParam && (!Number.isInteger(tail) || tail < 1 || tail > 10000)) {
    return errorResponse(400, "invalid_parameter", "tail must be an integer between 1 and 10000", {}, requestId);
  }

  // Parse and validate service names
  let services: string[] | undefined;
  if (serviceParam) {
    services = serviceParam.split(",").map((s) => s.trim()).filter(Boolean);
    const invalid = services.filter((s) => !isAllowedService(s, state.configDir));
    if (invalid.length > 0) {
      return errorResponse(
        400,
        "invalid_service",
        `Invalid service name(s): ${invalid.join(", ")}`,
        { invalid },
        requestId
      );
    }
  }

  // Validate since format (basic sanity check — docker handles the actual parsing)
  if (sinceParam && !/^[a-zA-Z0-9.:+\-T]+$/.test(sinceParam)) {
    return errorResponse(400, "invalid_parameter", "since contains invalid characters", {}, requestId);
  }

  // Check Docker availability
  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    appendAudit(state, actor, "logs", { services: services ?? "all", tail, error: "docker_unavailable" }, false, requestId, callerType);
    return errorResponse(503, "docker_unavailable", "Docker is not available", {}, requestId);
  }

  const result = await composeLogs(services, tail, {
    files: buildComposeFileList(state),
    envFiles: buildEnvFiles(state),
    since: sinceParam ?? undefined
  });

  appendAudit(
    state,
    actor,
    "logs",
    { services: services ?? "all", tail, since: sinceParam ?? undefined },
    result.ok,
    requestId,
    callerType
  );

  if (!result.ok) {
    return jsonResponse(500, { ok: false, logs: "", error: result.stderr }, requestId);
  }

  // docker compose logs writes to stderr by default, combine both streams
  const logs = (result.stdout + result.stderr).trim();
  return jsonResponse(200, { ok: true, logs }, requestId);
};
