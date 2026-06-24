import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { withSerialQueue } from "$lib/server/serial-queue.js";
import {
  applyHomeReconcile,
  createLogger,
  MigrationError,
  BackupSpaceError,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("migrate-apply");

/**
 * Apply everything OP_HOME needs to match the running platform, and report the
 * result. Runs the single home-reconcile primitive (`applyHomeReconcile`):
 * layout + release migrations (full-home backup first, idempotent), then secrets,
 * skeleton seed, and OpenCode config. This is the deliberate, user-clicked write
 * path that replaced the per-request self-healing — serving the UI is a pure read.
 *
 * This does NOT pull images or recreate containers — it only reconciles the home
 * directory so the splash landing can unblock a user whose home is behind, then
 * route them onward.
 *
 * BackupSpaceError (the pre-backup free-space guard) is surfaced as 409 with the
 * estimate so the UI can ask the user to confirm before retrying with
 * `confirmLowSpace: true`. Nothing is modified when that fires.
 */
export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  let body: { confirmLowSpace?: boolean };
  try { body = await event.request.json(); } catch { body = {}; }
  const confirmLowSpace = body.confirmLowSpace === true;

  // Serialize on the same queue as install/update: applyHomeReconcile takes the
  // install lock, but that lock is per-process reentrant, so two concurrent
  // reconciles in this UI process (e.g. a double-clicked "apply" button) would
  // otherwise interleave their OP_HOME writes. The queue gives real mutual
  // exclusion across all three lock-taking endpoints.
  return withSerialQueue("admin:install", async () => {
  const state = getState();

  try {
    const { migration, backupDir } = await applyHomeReconcile(state, { confirmLowSpace });
    logger.info("home reconciled", {
      requestId,
      migrated: migration.migrated,
      from: migration.from,
      to: migration.to,
      releaseApplied: migration.releaseApplied,
      backupDir,
    });
    return jsonResponse(200, {
      ok: true,
      migrated: migration.migrated,
      from: migration.from,
      to: migration.to,
      applied: migration.applied,
      releaseFrom: migration.releaseFrom,
      releaseTo: migration.releaseTo,
      releaseApplied: migration.releaseApplied,
      backupDir,
      notes: migration.notes,
    }, requestId);
  } catch (e) {
    if (e instanceof BackupSpaceError) {
      logger.warn("migration blocked: low free space", {
        requestId,
        estimatedBytes: e.estimatedBytes,
        freeBytes: e.freeBytes,
      });
      return errorResponse(409, "low_space", e.message, {
        guidance: e.guidance,
        estimatedBytes: e.estimatedBytes,
        freeBytes: e.freeBytes,
        confirmable: true,
      }, requestId);
    }
    if (e instanceof MigrationError) {
      logger.error("migration failed", { requestId, error: e.message, backupDir: e.backupDir });
      return errorResponse(500, "migration_failed", e.message, {
        guidance: e.guidance,
        backupDir: e.backupDir,
      }, requestId);
    }
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("migration failed (unexpected)", { requestId, error: msg });
    return errorResponse(500, "migration_failed", msg, {}, requestId);
  }
  });
};
