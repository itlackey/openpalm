/**
 * GET /admin/automations — List automation configs and scheduler status.
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
import { loadAutomations, getSchedulerStatus, getAllExecutionLogs } from "$lib/server/scheduler.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const allLogs = getAllExecutionLogs();

  const automations = loadAutomations(state.stateDir).map((c) => ({
    name: c.name,
    description: c.description,
    schedule: c.schedule,
    timezone: c.timezone,
    enabled: c.enabled,
    action: {
      type: c.action.type,
      method: c.action.method,
      path: c.action.path,
      url: c.action.url
    },
    on_failure: c.on_failure,
    fileName: c.fileName,
    logs: allLogs[c.fileName] ?? []
  }));

  const scheduler = getSchedulerStatus();

  appendAudit(state, actor, "automations.list", {}, true, requestId, callerType);

  return jsonResponse(200, { automations, scheduler }, requestId);
};
