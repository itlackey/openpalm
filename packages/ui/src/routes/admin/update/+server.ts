import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { withSerialQueue } from "$lib/server/serial-queue.js";
import {
  applyUpdate,
  createLogger,
  buildComposeOptions,
  checkDocker,
  applyStack,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("update");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("update request received", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  // Optional body: { service?: string } for scoped single-service updates (§4, §7).
  // When service is present, skip the managed-file apply (no file changes) and only
  // pull + recreate that one container — updating one container MUST NOT touch others.
  let service: string | undefined;
  try {
    const body = event.request.headers.get("content-type")?.includes("application/json")
      ? await event.request.json() as { service?: unknown }
      : {};
    if (typeof body?.service === "string" && body.service.trim()) {
      service = body.service.trim();
    }
  } catch {
    // No body or unparseable — treat as "all" (backward compat)
  }

  return withSerialQueue("admin:update", async () => {
    try {
      const state = getState();
      const composeOpts = buildComposeOptions(state);

      const dockerCheck = await checkDocker();
      if (!dockerCheck.ok) {
        // Docker unavailable: user pressed "update now" but the daemon is down.
        // Per §6 "registry-down is handled by who asked" — a user-triggered update
        // that cannot reach Docker fails loudly with overallSuccess:false.
        logger.info("Docker unavailable — update rejected", { requestId });
        return jsonResponse(200, {
          ok: false,
          restarted: [],
          failed: [],
          dockerAvailable: false,
          overallSuccess: false,
        }, requestId);
      }

      if (service) {
        // Scoped single-service update (§4, §7 "Update <container>"):
        // pull + recreate ONLY this service; do NOT run applyUpdate (no file changes).
        // Pull failure is FATAL — never falls through to a stale local image (§6).
        logger.info("scoped service update", { requestId, service });
        const stackResult = await applyStack({ kind: "service", service }, composeOpts);
        const overallSuccess = stackResult.ok;
        const status = stackResult.ok ? 200 : 502;
        logger.info("service update completed", {
          requestId,
          service,
          overallSuccess,
          startedCount: stackResult.started.length,
          failedCount: stackResult.failed.length,
          error: stackResult.error,
        });
        return jsonResponse(status, {
          ok: overallSuccess,
          restarted: stackResult.started,
          failed: stackResult.failed,
          dockerAvailable: true,
          overallSuccess,
          ...(stackResult.error ? { error: stackResult.error } : {}),
        }, requestId);
      }

      // Full update ("Update everything"): apply managed files first, then pull + recreate all.
      // applyUpdate runs the unified OP_HOME apply (dirs, secrets, overwrite the
      // managed system/ tree, seed user/data once, OpenCode config — all idempotent)
      // and writes runtime files. It does NOT compose; the compose phase below is
      // the sole stack driver (pull-then-recreate; pull failure is FATAL per §6).
      const result = await applyUpdate(state);
      logger.info("update applied, running applyStack", {
        requestId,
        intended: result.restarted,
      });

      // applyStack: pull the whole set first (§4.3), then recreate.
      // Pull failure is FATAL — never falls through to a stale local image (§6).
      const stackResult = await applyStack({ kind: "all" }, composeOpts);

      const overallSuccess = stackResult.ok;
      const status = stackResult.ok ? 200 : 502;

      logger.info("update completed", {
        requestId,
        dockerAvailable: true,
        overallSuccess,
        startedCount: stackResult.started.length,
        failedCount: stackResult.failed.length,
        error: stackResult.error,
      });

      return jsonResponse(
        status,
        {
          ok: overallSuccess,
          restarted: stackResult.started,
          failed: stackResult.failed,
          dockerAvailable: true,
          overallSuccess,
          ...(stackResult.error ? { error: stackResult.error } : {}),
        },
        requestId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("update failed", { requestId, error: msg });
      return errorResponse(500, "update_failed", msg, {}, requestId);
    }
  });
};
