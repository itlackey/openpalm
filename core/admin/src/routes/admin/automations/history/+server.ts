/**
 * GET /admin/automations/history — Get execution history for automations.
 *
 * Query params:
 *   ?limit=50   — max entries to return (default 50, max 200)
 *   ?jobId=...  — filter to a specific job ID
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { appendAudit } from "$lib/server/control-plane.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const url = new URL(event.request.url);
  const limitParam = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 50 : limitParam), 200);
  const jobId = url.searchParams.get("jobId") ?? undefined;

  let history = [...state.automations.history].reverse();
  if (jobId) {
    history = history.filter((h) => h.jobId === jobId);
  }
  history = history.slice(0, limit);

  appendAudit(
    state,
    getActor(event),
    "automations.history",
    { limit, jobId: jobId ?? null },
    true,
    requestId,
    getCallerType(event)
  );

  return jsonResponse(200, { history }, requestId);
};
