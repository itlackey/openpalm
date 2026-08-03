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
import { automationRuntimeErrorResponse } from '$lib/server/automation-runtime.js';
import { assertSchedulableTaskFilename, readAutomationLogs } from '@openpalm/lib';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;
  const capabilityError = requireCapability(event, 'host:logs', requestId);
  if (capabilityError) return capabilityError;

  const state = getState();
  const fileName = event.params.name ?? "";
  try {
    assertSchedulableTaskFilename(fileName);
  } catch {
    return errorResponse(
      400,
      "invalid_input",
      "name must be a path-safe basename ending in .yml",
      {},
      requestId,
    );
  }

  const limitParam = event.url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!/^[1-9][0-9]*$/.test(limitParam) || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      return errorResponse(400, "invalid_input", "limit must be a positive integer", {}, requestId);
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  try {
    const lines = await readAutomationLogs(state, fileName, limit);
    return jsonResponse(200, { fileName, lines }, requestId);
  } catch (error) {
    return automationRuntimeErrorResponse(error, requestId);
  }
};
