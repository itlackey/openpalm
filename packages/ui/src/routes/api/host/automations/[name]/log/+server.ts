/**
 * GET /api/host/automations/:name/log — Recent execution logs for an automation.
 *
 * Reads per-run log files from the AKM task log directory:
 *   ${dataDir}/akm/cache/tasks/logs/<id>/<timestamp>.log
 *
 * Optional `limit` query parameter caps the number of returned log lines
 * (default 50, max 500).
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  requireCapability,
  getRequestId,
} from "$lib/server/helpers.js";
import { readAutomationLogs } from "@openpalm/lib";

const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+(?:\.ya?ml)?$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:logs', requestId);
  if (capabilityError) return capabilityError;
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const rawName = event.params.name ?? "";
  const taskId = rawName.replace(/\.ya?ml$/, '');

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

  const lines = readAutomationLogs(taskId, state.dataDir, limit);

  return jsonResponse(200, { name: taskId, lines }, requestId);
};
