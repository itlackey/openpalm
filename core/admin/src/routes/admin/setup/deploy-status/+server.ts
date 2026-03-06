/**
 * GET /admin/setup/deploy-status — Poll background deployment progress.
 *
 * Returns per-service status so the UI can show progress indicators.
 * Auth: setup token during wizard, admin token after setup.
 */
import type { RequestHandler } from "./$types";
import {
  jsonResponse,
  getRequestId,
  requireAdminOrSetupToken,
} from "$lib/server/helpers.js";
import { getDeployStatus } from "$lib/server/deploy-tracker.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdminOrSetupToken(event, requestId);
  if (authError) return authError;

  const status = getDeployStatus();
  if (!status) {
    return jsonResponse(200, { active: false }, requestId);
  }

  return jsonResponse(200, { active: true, ...status }, requestId);
};
