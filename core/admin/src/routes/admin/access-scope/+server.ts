/**
 * GET /admin/access-scope — Read current access scope.
 * POST /admin/access-scope — Update access scope (host/lan).
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType,
  parseJsonBody
} from "$lib/server/helpers.js";
import {
  appendAudit,
  detectAccessScope,
  readCoreCaddyfile,
  setCoreCaddyAccessScope,
  stageArtifacts,
  persistArtifacts,
  buildComposeFileList,
  buildEnvFiles
} from "$lib/server/control-plane.js";
import { caddyReload, checkDocker } from "$lib/server/docker.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const scope = detectAccessScope(readCoreCaddyfile());

  appendAudit(state, actor, "accessScope.get", {}, true, requestId, callerType);
  return jsonResponse(200, { accessScope: scope }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const body = await parseJsonBody(event.request);
  const scope = String(body.scope ?? "");

  if (scope !== "host" && scope !== "lan") {
    appendAudit(state, actor, "accessScope.set", { scope }, false, requestId, callerType);
    return errorResponse(400, "invalid_input", "scope must be 'host' or 'lan'", { scope }, requestId);
  }

  const updated = setCoreCaddyAccessScope(scope);
  if (!updated.ok) {
    appendAudit(state, actor, "accessScope.set", { scope, error: updated.error }, false, requestId, callerType);
    return errorResponse(500, "invalid_state", updated.error, {}, requestId);
  }

  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);

  // Reload Caddy to apply new access scope
  const dockerCheck = await checkDocker();
  if (dockerCheck.ok) {
    await caddyReload(state.stateDir, { files: buildComposeFileList(state), envFiles: buildEnvFiles(state) });
  }

  appendAudit(state, actor, "accessScope.set", { scope }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, accessScope: scope }, requestId);
};
