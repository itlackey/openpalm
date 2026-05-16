import {
  getRequestId,
  jsonResponse,
  requireAdmin,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  applyUninstall,
  buildComposeOptions,
  createLogger,
  composeDown,
  checkDocker,
} from "@openpalm/lib";
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
    dockerResult = await composeDown(buildComposeOptions(state));
  }

  logger.info("stopping containers and applying uninstall", { requestId, dockerAvailable: dockerCheck.ok });
  // audit recorded inside lib via ctx
  const result = await applyUninstall(state, { actor, requestId, callerType });
  logger.info("uninstall completed", { requestId, stopped: result.stopped });

  return jsonResponse(200, { ok: true, ...result, dockerAvailable: dockerCheck.ok }, requestId);
};
