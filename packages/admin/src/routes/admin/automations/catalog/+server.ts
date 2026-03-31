/**
 * GET /admin/automations/catalog — List available catalog automations.
 *
 * Addon management is handled via /admin/addons.
 * This endpoint returns installable automations only.
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

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAuth(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const automations = discoverRegistryAutomations().map((auto) => ({
    name: auto.name,
    type: 'automation' as const,
    installed: existsSync(`${state.configDir}/automations/${auto.name}.yml`),
    description: auto.description,
    schedule: auto.schedule,
  }));

  appendAudit(state, actor, "automations.catalog.list", { source: 'registry' }, true, requestId, callerType);
  return jsonResponse(200, { automations, source: 'registry' }, requestId);
};
