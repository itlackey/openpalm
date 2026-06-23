import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  performUpgrade,
  createLogger,
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  ensureSecrets,
  ensureHomeDirs,
  ensureMigrated,
  MigrationError,
  checkDocker,
  isPrerelease,
  PLATFORM_VERSION,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("upgrade");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("upgrade request received", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  // Pre-state layout migration gate. This MUST run before getState() —
  // createState()/initializeStateSecrets() resolve and write to the CURRENT
  // layout, so on a 0.10.x home they'd target paths that only exist post-migration.
  // performUpgrade later re-runs ensureMigrated idempotently (inside
  // reconcileStack → reconcileHome), but only AFTER state is built; this explicit
  // call is the pre-state gate and is NOT redundant. Backs up first; no-ops on an
  // already-current home.
  try {
    const report = ensureMigrated();
    if (report.migrated) {
      logger.info("layout migrated", { requestId, from: report.from, to: report.to, backupDir: report.backupDir, notes: report.notes });
    }
  } catch (e) {
    if (e instanceof MigrationError) {
      logger.error("auto-migration aborted", { requestId, error: e.message, backupDir: e.backupDir });
      return errorResponse(500, "migration_failed", e.message, { guidance: e.guidance, backupDir: e.backupDir }, requestId);
    }
    throw e;
  }

  const state = getState();

  ensureHomeDirs();
  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig();
  ensureSecrets(state);

  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    logger.error("upgrade aborted: docker unavailable", { requestId, stderr: dockerCheck.stderr });
    return errorResponse(503, "docker_unavailable", "Docker is not available", { stderr: dockerCheck.stderr }, requestId);
  }

  let result;
  try {
    // Pass the control-plane's prerelease status as caller intent. NOTE:
    // allowPrerelease is currently a NO-OP in performUpgrade (the upgrade target
    // is always the running PLATFORM_VERSION and image tags are user-pinned in
    // stack.env — there is no remote tag to gate). We still derive and pass it so
    // a future remote-resolution gate works without changing this call site.
    result = await performUpgrade(state, { allowPrerelease: isPrerelease(PLATFORM_VERSION) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("upgrade failed", { requestId, error: msg });
    return errorResponse(502, "upgrade_failed", msg, { message: msg }, requestId);
  }

  logger.info("upgrade completed", { requestId, imageTag: result.imageTag, assetsUpdated: result.assetsUpdated });

  return jsonResponse(200, {
    ok: true,
    imageTag: result.imageTag,
    backupDir: result.backupDir,
    assetsUpdated: result.assetsUpdated,
    restarted: result.restarted,
  }, requestId);
};
