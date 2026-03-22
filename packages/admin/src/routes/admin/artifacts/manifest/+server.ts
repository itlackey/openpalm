/**
 * GET /admin/artifacts/manifest — Full artifact manifest (same shape as manifest.json on disk).
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import { jsonResponse, requireAuth, getRequestId, getActor, getCallerType } from "$lib/server/helpers.js";
import { appendAudit } from "@openpalm/lib";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAuth(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  appendAudit(state, actor, "artifacts.manifest", {}, true, requestId, callerType);
  return jsonResponse(200, { manifest: state.artifactMeta }, requestId);
};
