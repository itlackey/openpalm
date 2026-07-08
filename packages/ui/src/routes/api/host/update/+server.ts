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
  applyUpdate,
  createLogger,
  buildComposeOptions,
  checkDocker,
  applyStack,
  patchSecretsEnvFile,
  isVersionKey,
  acquireInstallLock,
  releaseInstallLock,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("update");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:updates', requestId);
  if (capabilityError) return capabilityError;
  logger.info("update request received", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  // Optional body:
  //   { service?: string } — scoped single-service update (§4, §7); pull + recreate
  //     ONLY that container, never touching others.
  //   { versions?: { OP_<X>_VERSION: "<target>" } } — the version each component
  //     should ADVANCE to before recreate (the channel-latest the UI resolved, or a
  //     deliberate pin). Without this, "update" just re-applies the current tag and
  //     can never move forward on a channel whose releases are specific tags (next/
  //     beta have no moving tag). Targets are written to the legacy stack.env — the
  //     APPLIED/current tracker — NOT state/ (state is for deliberate pins; writing
  //     an applied version there would make it read back as a pin and re-freeze).
  let service: string | undefined;
  const targetVersions: Record<string, string> = {};
  try {
    const body = event.request.headers.get("content-type")?.includes("application/json")
      ? await event.request.json() as { service?: unknown; versions?: unknown }
      : {};
    if (typeof body?.service === "string" && body.service.trim()) {
      service = body.service.trim();
    }
    if (body?.versions && typeof body.versions === "object") {
      for (const [k, v] of Object.entries(body.versions as Record<string, unknown>)) {
        if (isVersionKey(k) && typeof v === "string" && v.trim()) {
          targetVersions[k] = v.trim();
        }
      }
    }
  } catch {
    // No body or unparseable — treat as "all" with no explicit targets (backward compat).
  }

  return withSerialQueue("admin:update", async () => {
    const state = getState();

    // Hold the install lock across the file apply (applyUpdate) AND the container
    // apply (applyStack), for both the full-update and scoped-service branches.
    // Acquire once and pass {lock} to applyUpdate so it neither re-acquires nor
    // early-releases — mirroring runDeploy's pattern. Without this, applyUpdate
    // released the lock internally and a concurrent install could slip into the
    // applyStack window.
    const lock = acquireInstallLock(state.dataDir);
    if (!lock) {
      logger.info("update rejected — another install/update is in progress", { requestId });
      return errorResponse(
        409,
        "install_in_progress",
        "Another install or update is already running. Wait for it to finish, or run 'openpalm unlock' to clear a stale lock.",
        {},
        requestId,
      );
    }

    try {
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

      // Advance the APPLIED version right before whichever compose recreate call
      // actually consumes it, so `applyStack` pulls the NEW tag instead of
      // re-applying the current one. Written to legacy stack.env (the
      // applied/current tracker) — never state/, which is reserved for
      // deliberate pins (an applied version in state would read back as a pin
      // and re-freeze).
      //
      // Ordering is the point: for the full-update branch below, this MUST run
      // AFTER applyUpdate()'s own transactional file-write boundary succeeds —
      // advancing the pin before that boundary would leave stack.env pointing
      // at a version whose managed files were never actually written if
      // applyUpdate throws partway through.
      const advanceTargetVersions = (): void => {
        if (Object.keys(targetVersions).length === 0) return;
        patchSecretsEnvFile(state.homeDir, targetVersions);
        logger.info("advanced versions before recreate", { requestId, targetVersions });
      };

      if (service) {
        // Scoped single-service update (§4, §7 "Update <container>"):
        // pull + recreate ONLY this service; do NOT run applyUpdate (no file changes).
        // Pull failure is FATAL — never falls through to a stale local image (§6).
        // No applyUpdate precedes this branch, so there's no transactional
        // file-write boundary to sequence around — advance right before the
        // one mutation this branch performs.
        advanceTargetVersions();
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
      const result = await applyUpdate(state, { lock });
      logger.info("update applied, running applyStack", {
        requestId,
        intended: result.restarted,
      });

      // Only NOW — after applyUpdate's transactional file-write boundary has
      // actually succeeded — advance the version pin applyStack is about to
      // read (see advanceTargetVersions above for why the ordering matters).
      advanceTargetVersions();

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
    } finally {
      releaseInstallLock(lock);
    }
  });
};
