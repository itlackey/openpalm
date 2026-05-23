/**
 * GET /admin/automations — List automation configs from stash/tasks/.
 *
 * Read-only endpoint. Automations are AKM markdown task files at
 * ${stashDir}/tasks/*.md. The OS cron daemon (in the assistant container)
 * handles scheduling; `akm tasks run <id>` handles execution.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  requireAuth,
  getRequestId,
} from "$lib/server/helpers.js";
import { loadAutomations } from "@openpalm/lib";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAuth(event, requestId);
  if (authErr) return authErr;

  const state = getState();

  const automations = loadAutomations(state.stashDir).map((c) => ({
    name: c.name,
    description: c.description,
    schedule: c.schedule,
    enabled: c.enabled,
    action: {
      type: c.action.type,
      content: c.action.content,
      agent: c.action.agent
    },
    fileName: c.fileName,
  }));

  return jsonResponse(200, { automations }, requestId);
};
