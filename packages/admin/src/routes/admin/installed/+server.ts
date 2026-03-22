/**
 * GET /admin/installed — List installed channels and active services.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  requireAuth,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { appendAudit, discoverChannels } from "@openpalm/lib";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAuth(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const installed = discoverChannels(state.configDir).map((ch) => ch.name);

  appendAudit(state, actor, "extensions.list", {}, true, requestId, callerType);
  return jsonResponse(
    200,
    {
      installed,
      activeServices: state.services
    },
    requestId
  );
};
