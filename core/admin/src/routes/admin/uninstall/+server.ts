import {
  getRequestId,
  jsonResponse,
  requireAdmin,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { applyUninstall, appendAudit, buildComposeFileList, buildEnvFiles } from "$lib/server/control-plane.js";
import { composeDown, checkDocker } from "$lib/server/docker.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  // Stop Docker containers first
  const dockerCheck = await checkDocker();
  let dockerResult = null;
  if (dockerCheck.ok) {
    dockerResult = await composeDown(state.stateDir, { files: buildComposeFileList(state), envFiles: buildEnvFiles(state) });
  }

  const result = applyUninstall(state);

  appendAudit(
    state,
    actor,
    "uninstall",
    { stopped: result.stopped, dockerAvailable: dockerCheck.ok },
    true,
    requestId,
    callerType
  );

  return jsonResponse(200, { ok: true, ...result, dockerAvailable: dockerCheck.ok }, requestId);
};
