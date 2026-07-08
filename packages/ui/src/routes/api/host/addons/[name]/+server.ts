/**
 * GET  /api/host/addons/:name — Return addon detail.
 * POST /api/host/addons/:name — Enable or disable an addon.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  requireCapability,
  getRequestId,
  parseJsonBody,
  jsonBodyError,
} from "$lib/server/helpers.js";
import {
  createLogger,
  listAvailableAddonIds,
  listEnabledAddonIds,
  getRegistryAddonConfig,
} from "@openpalm/lib";
import { performAddonToggle } from "$lib/server/addon-helpers.js";

const logger = createLogger("addons.name");

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:addons', requestId);
  if (capabilityError) return capabilityError;
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const name = event.params.name;

  if (!listAvailableAddonIds().includes(name)) {
    return errorResponse(404, "not_found", `Addon "${name}" is not available`, { name }, requestId);
  }

  const enabled = listEnabledAddonIds(state.homeDir).includes(name);
  let config: ReturnType<typeof getRegistryAddonConfig>;
  try {
    config = getRegistryAddonConfig(name);
  } catch (error) {
    logger.error("failed to read addon schema", { name, error: String(error), requestId });
    return errorResponse(500, "internal_error", `Addon "${name}" schema is unavailable`, {}, requestId);
  }

  return jsonResponse(200, { name, enabled, config }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:addons', requestId);
  if (capabilityError) return capabilityError;
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const name = event.params.name;

  if (!listAvailableAddonIds().includes(name)) {
    return errorResponse(404, "not_found", `Addon "${name}" is not available`, { name }, requestId);
  }

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const body = result.data;

  const requestedEnabled: boolean | undefined = typeof body.enabled === "boolean" ? body.enabled : undefined;
  const toggle = await performAddonToggle(state, name, requestedEnabled, requestId);

  if (!toggle.ok) {
    return errorResponse(500, "internal_error", toggle.error, {}, requestId);
  }

  return jsonResponse(200, { ok: true, addon: name, enabled: toggle.enabled, changed: toggle.changed }, requestId);
};
