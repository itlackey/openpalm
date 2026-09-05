import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
  requireCapability,
  requireInstalledHome
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
  const notInstalled = requireInstalledHome(state.homeDir, requestId);
  if (notInstalled) return notInstalled;
  return withAdminUpdateLock(state, requestId, async (lock) => {
    try {
      // Stop Docker containers first
      const dockerCheck = await checkDocker();
      if (dockerCheck.ok) {
        let renameTeardown: Awaited<ReturnType<typeof teardownRenamedProject>>;
        try {
          renameTeardown = await teardownRenamedProject(state);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('previous project teardown verification failed', { requestId, error: message });
          return errorResponse(409, 'uninstall_teardown_failed', message, {}, requestId);
        }
        if (renameTeardown.blocked) {
          logger.error('previous project teardown blocked uninstall', {
            requestId,
            warning: renameTeardown.warning,
          });
          return errorResponse(
            409,
            'uninstall_teardown_failed',
            renameTeardown.warning ?? 'The previous OpenPalm project could not be stopped.',
            {},
            requestId,
          );
        }
        try {
          await activateComposeCommand(state, ['down'], { lock });
        } catch (err) {
          logger.warn('compose teardown failed during uninstall; continuing', {
            requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
