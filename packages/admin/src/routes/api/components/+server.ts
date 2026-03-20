/**
 * GET /api/components — List available components from all catalog sources.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType,
} from "$lib/server/helpers.js";
import {
  appendAudit,
  discoverComponents,
} from "$lib/server/control-plane.js";
import type { ComponentResponse } from "$lib/types.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const defs = discoverComponents(state.homeDir);

  const components: ComponentResponse[] = defs.map((c) => ({
    id: c.id,
    source: c.source,
    labels: c.labels,
  }));

  appendAudit(state, actor, "components.list", {}, true, requestId, callerType);
  return jsonResponse(200, { components, requestId }, requestId);
};
