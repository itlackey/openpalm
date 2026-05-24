import {
  getRequestId,
  jsonResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { withSerialQueue } from "$lib/server/serial-queue.js";
import {
  applyUpdate,
  createLogger,
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  buildComposeOptions,
  buildManagedServices,
  ensureHomeDirs,
  composeUp,
  checkDocker,
  parseComposeStderr,
  summarizeComposeStderr,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("update");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("update request received", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  return withSerialQueue("admin:update", async () => {
    const state = getState();

    ensureHomeDirs();
    ensureOpenCodeConfig();
    ensureOpenCodeSystemConfig();
    // OpenCode session logs are the audit trail (D6a).
    const result = await applyUpdate(state);
    logger.info("update applied, re-running compose", {
      requestId,
      intended: result.restarted,
    });

    // Re-apply compose with updated artifacts (include all channel overlays).
    const dockerCheck = await checkDocker();
    const intendedServices = await buildManagedServices(state);
    let restarted: string[] = [];
    let failed: { service: string; reason: string }[] = [];
    let dockerError: string | undefined;

    if (dockerCheck.ok) {
      const composeResult = await composeUp({
        ...buildComposeOptions(state),
        services: intendedServices,
      });

      if (composeResult.ok) {
        restarted = intendedServices;
      } else {
        // Parse compose stderr for per-service failures. Compose prints
        // status lines on stderr; a single bad addon can cause `up` to
        // exit non-zero while other services come up fine — so we still
        // report the unaffected services as "restarted".
        failed = parseComposeStderr(composeResult.stderr);
        const failedNames = new Set(failed.map((f) => f.service));
        restarted = intendedServices.filter((s) => !failedNames.has(s));

        // If we couldn't attribute the failure to any of the intended
        // services, surface a stack-level error so the operator at least
        // sees the underlying daemon message.
        if (failed.length === 0) {
          const summary = summarizeComposeStderr(composeResult.stderr) ||
            `docker compose exited with code ${composeResult.code}`;
          failed = [{ service: "stack", reason: summary }];
          // We have no way to know which services started; be conservative.
          restarted = [];
        }

        dockerError = summarizeComposeStderr(composeResult.stderr);
        logger.warn("compose up reported failures", {
          requestId,
          code: composeResult.code,
          failed,
          restarted,
        });
      }
    }

    const overallSuccess = dockerCheck.ok && failed.length === 0;
    // 502 only on real compose failures. Docker being unavailable is a
    // separate signal (`dockerAvailable: false`) — the artifacts were still
    // written successfully, the operator just needs to start docker.
    const status = failed.length > 0 ? 502 : 200;

    logger.info("update completed", {
      requestId,
      dockerAvailable: dockerCheck.ok,
      overallSuccess,
      restartedCount: restarted.length,
      failedCount: failed.length,
    });

    return jsonResponse(
      status,
      {
        ok: overallSuccess,
        restarted,
        failed,
        dockerAvailable: dockerCheck.ok,
        overallSuccess,
        ...(dockerError ? { error: dockerError } : {}),
      },
      requestId,
    );
  });
};
