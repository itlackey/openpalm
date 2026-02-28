/**
 * GET /admin/config/sync/status — Return current sync status and config.
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
import { getProvider, readSyncConfig } from "$lib/server/sync/index.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const provider = getProvider(state.configDir);
  const status = await provider.status(state.configDir);
  const config = readSyncConfig(state.configDir);

  appendAudit(state, actor, "config.sync.status", {}, true, requestId, callerType);

  return jsonResponse(200, { ...status, config }, requestId);
};
