/**
 * GET /api/host/automations — List automation configs from knowledge/tasks/.
 *
 * Read-only endpoint. Automations are AKM task files at
 * ${stashDir}/tasks/*.yml. The scheduler runs as a co-process inside the
 * assistant; `akm tasks run <id>` handles execution.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  requireAdmin,
  requireCapability,
  getRequestId,
} from "$lib/server/helpers.js";
import { loadAutomations } from "@openpalm/lib";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:stack:read', requestId);
  if (capabilityError) return capabilityError;
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();

  const automations = loadAutomations(state.stashDir).map((c) => ({
    name: c.name,
    description: c.description,
    schedule: c.schedule,
    timezone: c.timezone,
    enabled: c.enabled,
    action: {
      type: c.action.type,
      content: c.action.content,
      agent: c.action.agent
    },
    on_failure: c.on_failure,
    fileName: c.fileName,
  }));

  return jsonResponse(200, { automations }, requestId);
};
