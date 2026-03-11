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
import { createLogger } from "$lib/server/logger.js";
import type { RequestHandler } from "./$types";

const logger = createLogger("uninstall");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("uninstall request received", { requestId });
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

  logger.info("stopping containers and applying uninstall", { requestId, dockerAvailable: dockerCheck.ok });
  const result = applyUninstall(state);
  logger.info("uninstall completed", { requestId, stopped: result.stopped });

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
