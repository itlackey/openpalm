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
  checkDocker,
  applyStack,
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
      // the user/data trees once, OpenCode config — all idempotent. Does NOT compose.
      await applyInstall(state);

      const dockerCheck = await checkDocker();
      if (!dockerCheck.ok) {
        logger.info("install completed (Docker unavailable — stack not started)", { requestId });
        return jsonResponse(200, {
          ok: true,
          started: [],
          failed: [],
          dockerAvailable: false,
          overallSuccess: true,
        }, requestId);
      }

      // applyStack: pull the whole set first (§4.3 "pull before recreate, always"),
      // then bring the stack up. Pull failure is FATAL per §6.
      const composeOpts = buildComposeOptions(state);
      const stackResult = await applyStack({ kind: "all" }, composeOpts);

      const overallSuccess = stackResult.ok;
      const status = stackResult.ok ? 200 : 502;

      logger.info("install completed", {
        requestId,
        dockerAvailable: true,
        overallSuccess,
        startedCount: stackResult.started.length,
        failedCount: stackResult.failed.length,
      });

      return jsonResponse(
        status,
        {
          ok: overallSuccess,
          started: stackResult.started,
          failed: stackResult.failed,
          dockerAvailable: true,
          overallSuccess,
          ...(stackResult.error ? { error: stackResult.error } : {}),
        },
        requestId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("install failed", { requestId, error: msg });
      return errorResponse(500, "install_failed", msg, {}, requestId);
    }
  });
};
