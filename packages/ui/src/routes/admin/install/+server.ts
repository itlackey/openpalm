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
  ensureMigrated,
  MigrationError,
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
      // 0. Pre-state layout migration gate. MUST run before getState() —
      // createState()/initializeStateSecrets() resolve and write to the CURRENT
      // layout, so on a pre-2 home they'd target paths that only exist post-migration.
      // applyInstall later re-runs migrations idempotently inside reconcileHome
      // (defused by the reentrant install lock), but this explicit pre-state call
      // is what surfaces a MigrationError to the operator before any state work and
      // pre-stamps the layout. Backs up first; no-ops on an already-current home.
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

      // Reconcile OP_HOME: layout migrations, dir tree, secrets, skeleton seed,
      // OpenCode config, release transforms — all idempotent, all inside
      // applyInstall's reconcile. Writes runtime files but does NOT compose; the
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
