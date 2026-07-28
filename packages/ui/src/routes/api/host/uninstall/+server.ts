import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
  requireCapability,
} from "$lib/server/helpers.js";
import { withAdminUpdateLock } from '$lib/server/admin-update-lock.js';
import { getState } from "$lib/server/state.js";
import {
  applyUninstall,
  createLogger,
  activateComposeCommand,
  checkDocker,
  teardownRenamedProject,
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

  const state = getState();
  return withAdminUpdateLock(state, requestId, async (lock) => {
    try {
      // Stop Docker containers first
      const dockerCheck = await checkDocker();
      if (dockerCheck.ok) {
        const renameTeardown = await teardownRenamedProject(state);
        if (renameTeardown.blocked) {
          return errorResponse(
            502,
            'project_rename_teardown_failed',
            renameTeardown.warning ?? 'Failed to stop the previous project',
            {},
            requestId,
          );
        }
        await activateComposeCommand(state, ['down'], { lock });
      }

      logger.info("stopping containers and applying uninstall", { requestId, dockerAvailable: dockerCheck.ok });
      // OpenCode session logs are the audit trail (D6a).
      const result = await applyUninstall(state, { lock });
      logger.info("uninstall completed", { requestId, stopped: result.stopped });

      return jsonResponse(200, { ok: true, ...result, dockerAvailable: dockerCheck.ok }, requestId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("uninstall failed", { requestId, error: msg });
      return errorResponse(500, "uninstall_failed", msg, {}, requestId);
    }
  });
};
