import {
  getRequestId,
  jsonResponse,
  requireAdmin,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { appendAudit, buildComposeFileList, buildEnvFiles } from "$lib/server/control-plane.js";
import { composePs, checkDocker } from "$lib/server/docker.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  // Try to get real Docker status
  const dockerCheck = await checkDocker();
  let dockerContainers = null;
  if (dockerCheck.ok) {
    const ps = await composePs(state.stateDir, { files: buildComposeFileList(state), envFiles: buildEnvFiles(state) });
    if (ps.ok && ps.stdout.trim()) {
      try {
        // docker compose ps --format json returns one JSON object per line
        dockerContainers = ps.stdout
          .trim()
          .split("\n")
          .filter((l) => l.startsWith("{"))
          .map((l) => JSON.parse(l));
      } catch {
        dockerContainers = null;
      }
    }
  }

  appendAudit(state, actor, "containers.list", {}, true, requestId, callerType);

  return jsonResponse(
    200,
    {
      containers: state.services,
      dockerContainers,
      dockerAvailable: dockerCheck.ok
    },
    requestId
  );
};
