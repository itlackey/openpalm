import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { withSerialQueue } from "$lib/server/serial-queue.js";
import {
  applyInstall,
  createLogger,
  buildComposeOptions,
  buildManagedServices,
  CORE_SERVICES,
  composeUp,
  checkDocker,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("install");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("install request received", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  return withSerialQueue("admin:install", async () => {
    try {
      const state = getState();

      // Apply OP_HOME: dir tree, secrets, overwrite the managed system/ tree, seed
      // the user/data trees once, OpenCode config — all idempotent, all inside
      // applyInstall's applyHome. Writes runtime files but does NOT compose; the
      // compose phase below is the sole composeUp (no double-recreate).
      await applyInstall(state);

      // 5. Run docker compose up — managed services derived from compose config
      const managedServices = await buildManagedServices(state);
      logger.info("checking Docker availability", { requestId });
      const dockerCheck = await checkDocker();
      let dockerResult = null;
      if (dockerCheck.ok) {
        logger.info("starting compose up", { requestId, services: managedServices });
        dockerResult = await composeUp({
          ...buildComposeOptions(state),
          services: managedServices
        });
      }

      const started = [...CORE_SERVICES];

      logger.info("install completed", { requestId, started, dockerAvailable: dockerCheck.ok, composeOk: dockerResult?.ok ?? null });

      return jsonResponse(
        200,
        {
          ok: true,
          started,
          dockerAvailable: dockerCheck.ok,
          composeResult: dockerResult
            ? { ok: dockerResult.ok, stderr: dockerResult.stderr }
            : null
        },
        requestId
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("install failed", { requestId, error: msg });
      return errorResponse(500, "install_failed", msg, {}, requestId);
    }
  });
};
