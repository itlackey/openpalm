import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  ensureMigrated,
  createLogger,
  MigrationError,
  BackupSpaceError,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("migrate-apply");

/**
 * Apply the pending on-disk migration and report the result. Runs the REAL
 * `ensureMigrated()` (layout migrations + release migrations up to the home's
 * recorded version), which takes a full-home backup first and is idempotent.
 *
 * This does NOT pull images or recreate containers — it only reconciles the home
 * directory so the splash "invalid state" landing can unblock a user whose home
 * needs migrating, then route them onward.
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

  const state = getState();
  const lines: string[] = [];

  try {
    const report = ensureMigrated({
      homeDir: state.homeDir,
      confirmLowSpace,
      log: (m) => lines.push(m),
    });
    logger.info("migration applied", {
      requestId,
      migrated: report.migrated,
      from: report.from,
      to: report.to,
      releaseApplied: report.releaseApplied,
      backupDir: report.backupDir,
    });
    return jsonResponse(200, {
      ok: true,
      migrated: report.migrated,
      from: report.from,
      to: report.to,
      applied: report.applied,
      releaseFrom: report.releaseFrom,
      releaseTo: report.releaseTo,
      releaseApplied: report.releaseApplied,
      backupDir: report.backupDir,
      notes: report.notes,
      lines,
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
        lines,
      }, requestId);
    }
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("migration failed (unexpected)", { requestId, error: msg });
    return errorResponse(500, "migration_failed", msg, { lines }, requestId);
  }
};
