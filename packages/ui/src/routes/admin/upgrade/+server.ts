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
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("upgrade");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("upgrade request received", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  // Auto-migrate the on-disk layout before touching state (getState/ensureSecrets
  // assume the current layout). Backs up first; no-ops on an already-current home.
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
    result = await performUpgrade(state);
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
