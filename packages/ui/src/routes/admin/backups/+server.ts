import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  summarizeBackups,
  listBackupDirs,
  pruneBackupDirs,
  createLogger,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("backups-admin");

/**
 * #499 — backup visibility. Returns count, total size, last-backup time and a
 * per-backup list (newest first) so the UI can surface the recovery net.
 * Read-only.
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  try {
    const summary = summarizeBackups(state.homeDir);
    return jsonResponse(200, { ok: true, ...summary }, requestId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse(500, "backups_list_failed", msg, {}, requestId);
  }
};

/**
 * #499 — drives the EXISTING confirm-gated prune. The UI must pass an explicit
 * `keep` count (the confirmation is the UI's modal); this NEVER auto-prunes and
 * keeps the newest `keep` snapshots, deleting only the older ones.
 */
export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  let body: { keep?: unknown };
  try { body = await event.request.json(); } catch { body = {}; }
  const keep = Number(body.keep);
  if (!Number.isInteger(keep) || keep < 0) {
    return errorResponse(400, "invalid_keep", "`keep` must be a non-negative integer", {}, requestId);
  }

  const state = getState();
  try {
    const existing = listBackupDirs(state.homeDir);
    const toDelete = existing.slice(keep);
    if (toDelete.length === 0) {
      return jsonResponse(200, { ok: true, deleted: [], kept: keep }, requestId);
    }
    const deleted = pruneBackupDirs(state.homeDir, keep);
    logger.info("pruned backups via admin", { requestId, deleted: deleted.length, kept: keep });
    return jsonResponse(200, { ok: true, deleted, kept: keep }, requestId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse(500, "backups_prune_failed", msg, {}, requestId);
  }
};
