/**
 * GET /admin/automations/catalog — List available catalog automations.
 *
 * Returns all automations from the registry catalog with an `installed`
 * flag indicating whether the task file exists in stash/tasks/.
 */
import type { RequestHandler } from "@sveltejs/kit";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  requireAuth,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import {
  appendAudit,
  discoverRegistryAutomations
} from "@openpalm/lib";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAuth(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const automations = discoverRegistryAutomations(state.stashDir).map((auto) => ({
    name: auto.name,
    type: 'automation' as const,
    installed: existsSync(join(state.stashDir, 'tasks', `${auto.name}.md`)),
    description: auto.description,
    schedule: auto.schedule,
  }));

  appendAudit(state, actor, "automations.catalog.list", { source: 'registry' }, true, requestId, callerType);
  return jsonResponse(200, { automations, source: 'registry' }, requestId);
};
