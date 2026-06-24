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
  checkDocker,
  buildComposeOptions,
  buildManagedServices,
  composeUp,
  summarizeComposeStderr,
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
 * After the home is reconciled it force-recreates the managed containers. The
 * reconcile alone only writes files (e.g. the seeded data/<svc>/tools manifests);
 * the assistant/guardian containers read those mounts and run `bun update` only
 * at startup, so they stay broken until recreated. No image pull — a migration
 * changes OP_HOME files, not the pinned image tags. This recreate is non-fatal:
 * the home is already fixed, so a recreate failure is surfaced as a note, not an
 * error (the user can restart from the dashboard).
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

    // Recreate the managed containers so they pick up the freshly-reconciled
    // OP_HOME (seeded tool manifests, patched compose env). They read those
    // mounts and run `bun update` only at startup, so without a recreate the
    // assistant/guardian stay broken even though the home is now correct.
    // Non-fatal: the home is already fixed; a recreate failure becomes a note.
    const notes = [...migration.notes];
    let restarted: string[] = [];
    const dockerCheck = await checkDocker();
    if (dockerCheck.ok) {
      const intendedServices = await buildManagedServices(state);
      const composeResult = await composeUp({
        ...buildComposeOptions(state),
        services: intendedServices,
        forceRecreate: true,
      });
      if (composeResult.ok) {
        restarted = intendedServices;
        logger.info("containers recreated after reconcile", { requestId, restarted });
      } else {
        const summary = summarizeComposeStderr(composeResult.stderr) ||
          `docker compose exited with code ${composeResult.code}`;
        notes.push(`Settings were updated, but services couldn't be restarted automatically (${summary}). Restart them from the dashboard.`);
        logger.warn("post-reconcile recreate failed", { requestId, summary });
      }
    } else {
      notes.push("Settings were updated, but the container runtime isn't available to restart your services. Start Docker, then restart from the dashboard.");
      logger.warn("post-reconcile recreate skipped — docker unavailable", { requestId });
    }

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
      restarted,
      notes,
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
