import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  inspectInstallLock,
  unlockInstallLock,
  INSTALL_LOCK_STALE_AFTER_MS,
  createLogger,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("unlock-admin");

/**
 * #500 — "an operation seems stuck — clear it?" Reports whether an install lock
 * is present and whether it is stale (so the UI can decide whether to offer the
 * clear action). Read-only.
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  try {
    const status = inspectInstallLock(state.dataDir);
    return jsonResponse(
      200,
      { ok: true, staleAfterMs: INSTALL_LOCK_STALE_AFTER_MS, ...status },
      requestId,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse(500, "unlock_status_failed", msg, {}, requestId);
  }
};

/**
 * #500 — clears the install lock ONLY when stale (dead holder PID or older than
 * the 30-minute staleness window). Returns 409 when a live install is still
 * holding the lock so the UI can surface "an operation is still running" rather
 * than forcing it. Never blind-removes a live lock.
 */
export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  // Explicit opt-in only: `{ "force": true }` clears a lock whose recorded PID
  // is still alive (the reused-PID case a liveness check cannot resolve). Absent
  // or non-true → stale-only behaviour.
  let force = false;
  try {
    const body = await event.request.clone().json();
    force = body?.force === true;
  } catch {
    /* no/invalid body — treat as a non-forced clear */
  }
  try {
    const result = unlockInstallLock(state.dataDir, { force });
    if (!result.ok) {
      return errorResponse(
        409,
        "install_in_progress",
        "An install or upgrade still appears to be running. The lock clears itself automatically once it finishes or after 30 minutes. Nothing was changed. Send { \"force\": true } to clear it anyway if the recorded PID was reused by an unrelated process.",
        { status: result.status },
        requestId,
      );
    }
    logger.info("cleared install lock via admin", {
      requestId,
      removed: result.removed,
      forced: force && result.status.present && !result.status.stale,
    });
    return jsonResponse(
      200,
      { ok: true, removed: result.removed, status: result.status },
      requestId,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse(500, "unlock_failed", msg, {}, requestId);
  }
};
