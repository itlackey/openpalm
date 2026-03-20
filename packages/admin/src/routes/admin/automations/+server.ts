/**
 * GET /admin/automations — List automation configs from STATE_HOME.
 *
 * Read-only endpoint. The scheduler sidecar is the sole automation engine;
 * admin does not run any background scheduler process. For execution logs
 * and live scheduler status, query the scheduler sidecar directly.
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
import { appendAudit } from "$lib/server/control-plane.js";
import { loadAutomations } from "$lib/server/scheduler.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAuth(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const automations = loadAutomations(state.configDir).map((c) => ({
    name: c.name,
    description: c.description,
    schedule: c.schedule,
    timezone: c.timezone,
    enabled: c.enabled,
    action: {
      type: c.action.type,
      method: c.action.method,
      path: c.action.path,
      url: c.action.url,
      content: c.action.content,
      agent: c.action.agent
    },
    on_failure: c.on_failure,
    fileName: c.fileName,
  }));

  appendAudit(state, actor, "automations.list", {}, true, requestId, callerType);

  return jsonResponse(200, { automations }, requestId);
};
