/**
 * GET /admin/config/sync/history — List recent config snapshots.
 *
 * Query params: ?limit=20 (default 20, max 100)
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { appendAudit } from "$lib/server/control-plane.js";
import { getProvider } from "$lib/server/sync/index.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const limitParam = event.url.searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitParam ?? "20", 10) || 20, 1), 100);

  const provider = getProvider(state.configDir);
  const result = await provider.history(state.configDir, limit);

  appendAudit(
    state, actor, "config.sync.history",
    { limit, ok: result.ok, count: result.snapshots.length },
    result.ok, requestId, callerType
  );

  if (!result.ok) {
    return errorResponse(500, "history_failed", result.error ?? "History failed", {}, requestId);
  }

  return jsonResponse(200, { snapshots: result.snapshots }, requestId);
};
