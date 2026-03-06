/**
 * GET /admin/setup/deploy-status — Poll background deployment progress.
 *
 * Returns per-service status so the UI can show progress indicators.
 * Auth: setup token during wizard, admin token after setup.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  getRequestId,
  safeTokenCompare,
} from "$lib/server/helpers.js";
import { isSetupComplete } from "$lib/server/setup-status.js";
import { getDeployStatus } from "$lib/server/deploy-tracker.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const state = getState();
  const setupComplete = isSetupComplete(state.stateDir, state.configDir);

  const token = event.request.headers.get("x-admin-token") ?? "";
  const validSetupToken =
    !setupComplete && safeTokenCompare(token, state.setupToken);
  const validAdminToken =
    setupComplete && safeTokenCompare(token, state.adminToken);
  if (!validSetupToken && !validAdminToken) {
    return errorResponse(401, "unauthorized", "Missing or invalid token", {}, requestId);
  }

  const status = getDeployStatus();
  if (!status) {
    return jsonResponse(200, { active: false }, requestId);
  }

  return jsonResponse(200, { active: true, ...status }, requestId);
};
