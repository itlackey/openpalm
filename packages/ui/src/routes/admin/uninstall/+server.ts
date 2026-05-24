import {
  getRequestId,
  jsonResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { withSerialQueue } from "$lib/server/serial-queue.js";
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

  return withSerialQueue("admin:uninstall", async () => {
    const state = getState();

    // Stop Docker containers first
    const dockerCheck = await checkDocker();
    let dockerResult = null;
    if (dockerCheck.ok) {
      dockerResult = await composeDown(buildComposeOptions(state));
    }

    logger.info("stopping containers and applying uninstall", { requestId, dockerAvailable: dockerCheck.ok });
    // OpenCode session logs are the audit trail (D6a).
    const result = await applyUninstall(state);
    logger.info("uninstall completed", { requestId, stopped: result.stopped });

    return jsonResponse(200, { ok: true, ...result, dockerAvailable: dockerCheck.ok }, requestId);
  });
};
