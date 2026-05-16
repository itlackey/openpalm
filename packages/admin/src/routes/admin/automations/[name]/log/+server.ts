/**
 * GET /admin/automations/:name/log — Recent execution logs for an automation.
 *
 * Reads per-run log files from the AKM task log directory:
 *   ${cacheDir}/akm/tasks/logs/<id>/<timestamp>.log
 *
 * Optional `limit` query parameter caps the number of returned log lines
 * (default 50, max 500).
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAuth,
  getRequestId,
  getActor,
  getCallerType,
} from "$lib/server/helpers.js";
import { appendAudit, readAutomationLogs } from "@openpalm/lib";

const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+(?:\.md)?$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAuth(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const rawName = event.params.name ?? "";
  const taskId = rawName.endsWith(".md") ? rawName.slice(0, -3) : rawName;

  if (!SAFE_NAME_RE.test(rawName) || rawName.includes("..") || rawName.includes("/")) {
    return errorResponse(400, "invalid_input", "name must match /^[a-zA-Z0-9._-]+$/", {}, requestId);
  }

  const limitParam = event.url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const parsed = Number.parseInt(limitParam, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return errorResponse(400, "invalid_input", "limit must be a positive integer", {}, requestId);
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const lines = readAutomationLogs(taskId, state.cacheDir, limit);

  appendAudit(state, actor, "automations.log", { name: taskId, count: lines.length }, true, requestId, callerType);
  return jsonResponse(200, { name: taskId, lines }, requestId);
};
