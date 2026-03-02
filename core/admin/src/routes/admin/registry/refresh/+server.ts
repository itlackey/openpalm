/**
 * POST /admin/registry/refresh — Re-stage artifacts and reload scheduler.
 *
 * Since registry items are bundled at build time via import.meta.glob,
 * a "refresh" re-stages artifacts from CONFIG_HOME into STATE_HOME and
 * reloads the scheduler to pick up any changes.
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
import {
  appendAudit,
  stageArtifacts,
  persistArtifacts
} from "$lib/server/control-plane.js";
import { reloadScheduler } from "$lib/server/scheduler.js";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);
  reloadScheduler(state.stateDir, state.adminToken);

  appendAudit(state, actor, "registry.refresh", {}, true, requestId, callerType);
  return jsonResponse(200, { ok: true }, requestId);
};
