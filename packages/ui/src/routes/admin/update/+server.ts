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
  ensureMigrated,
  MigrationError,
  buildComposeOptions,
  buildManagedServices,
  composePull,
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
    try {
    // Pre-state layout migration gate (see admin/install for the full rationale).
    // MUST run before getState(); applyUpdate re-runs it idempotently inside
    // reconcileHome (defused by the reentrant install lock). Backs up first.
    try {
      const report = ensureMigrated();
      if (report.migrated) {
        logger.info("layout migrated", { requestId, from: report.from, to: report.to, backupDir: report.backupDir });
      }
    } catch (e) {
      if (e instanceof MigrationError) {
        logger.error("auto-migration aborted", { requestId, error: e.message, backupDir: e.backupDir });
        return errorResponse(500, "migration_failed", e.message, { guidance: e.guidance, backupDir: e.backupDir }, requestId);
      }
      throw e;
    }

    const state = getState();

    // applyUpdate runs the unified OP_HOME reconcile (dirs, secrets, skeleton
    // seed, OpenCode config, migrations — all idempotent) and writes runtime
    // files; it does NOT compose. The compose phase below (pull-soft +
    // force-recreate + per-service failure parsing) is the sole composeUp.
    const result = await applyUpdate(state);
    logger.info("update applied, re-running compose", {
      requestId,
      intended: result.restarted,
    });

    // Re-apply compose with updated artifacts (include all portal overlays).
    const dockerCheck = await checkDocker();
    const intendedServices = await buildManagedServices(state);
    let restarted: string[] = [];
    let failed: { service: string; reason: string }[] = [];
    let dockerError: string | undefined;
    let pullWarning: string | undefined;

    if (dockerCheck.ok) {
      const composeOpts = buildComposeOptions(state);
      // Update must actually fetch newer images before recreating — otherwise it
      // only refreshes compose assets and recreates from whatever image is
      // already on disk (so a months-old assistant keeps running). Pull first;
      // a pull failure is non-fatal (offline / flaky network) — fall through to
      // recreate from local images.
      const pullResult = await composePull(composeOpts);
      if (!pullResult.ok) {
        const pullSummary = summarizeComposeStderr(pullResult.stderr) || "image pull failed";
        pullWarning = `Images could not be pulled — restarted from local cache. (${pullSummary})`;
        logger.warn("update: image pull failed — recreating from local images", {
          requestId, stderr: pullResult.stderr?.slice(0, 300),
        });
      }
      // forceRecreate so a freshly-pulled same-tag image actually swaps the
      // running container (a plain `up` may leave the old container in place).
      const composeResult = await composeUp({
        ...composeOpts,
        services: intendedServices,
        forceRecreate: true,
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
        ...(pullWarning ? { pullWarning } : {}),
        ...(dockerError ? { error: dockerError } : {}),
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
