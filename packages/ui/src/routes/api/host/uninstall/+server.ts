import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
  requireCapability,
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
  const capabilityError = requireCapability(event, 'host:recovery', requestId);
  if (capabilityError) return capabilityError;
  logger.info("uninstall request received", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  return withSerialQueue("admin:uninstall", async () => {
    try {
      const state = getState();

      // Stop Docker containers first
      const dockerCheck = await checkDocker();
      if (dockerCheck.ok) {
        await composeDown(buildComposeOptions(state));
      }

      logger.info("stopping containers and applying uninstall", { requestId, dockerAvailable: dockerCheck.ok });
      // OpenCode session logs are the audit trail (D6a).
      const result = await applyUninstall(state);
      logger.info("uninstall completed", { requestId, stopped: result.stopped });

      return jsonResponse(200, { ok: true, ...result, dockerAvailable: dockerCheck.ok }, requestId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("uninstall failed", { requestId, error: msg });
      return errorResponse(500, "uninstall_failed", msg, {}, requestId);
    }
  });
};
