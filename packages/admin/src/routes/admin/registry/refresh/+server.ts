/**
 * POST /admin/registry/refresh — Pull latest registry from GitHub and re-stage.
 *
 * Runs `git pull` on the cloned registry repo in the cache directory to fetch any
 * new or updated registry items from the remote repository.
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
import {
  appendAudit,
  resolveRuntimeFiles,
  writeRuntimeFiles,
  pullRegistry
} from "@openpalm/lib";


export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  // Pull latest from GitHub
  const pullResult = pullRegistry();
  if (pullResult.error) {
    appendAudit(state, actor, "registry.refresh", { error: pullResult.error }, false, requestId, callerType);
    return errorResponse(500, "registry_sync_error", pullResult.error, {}, requestId);
  }

  // Refresh runtime files (scheduler sidecar auto-reloads via file watching)
  state.artifacts = resolveRuntimeFiles();
  writeRuntimeFiles(state);

  appendAudit(state, actor, "registry.refresh", { updated: pullResult.updated }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, updated: pullResult.updated }, requestId);
};
