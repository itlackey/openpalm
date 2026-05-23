/**
 * GET  /admin/addons — Return available addons with enabled status.
 * POST /admin/addons — Enable or disable an addon.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  parseJsonBody,
  jsonBodyError,
} from "$lib/server/helpers.js";
import {
  listAvailableAddonIds,
  listEnabledAddonIds,
} from "@openpalm/lib";
import { performAddonToggle } from "$lib/server/addon-helpers.js";

type AddonItem = { name: string; enabled: boolean; available: boolean };

function buildAddonList(availableIds: string[], enabledIds: string[]): AddonItem[] {
  const enabledSet = new Set(enabledIds);
  return availableIds.map((name) => ({ name, enabled: enabledSet.has(name), available: true }));
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const availableIds = listAvailableAddonIds();
  const addons = buildAddonList(availableIds, listEnabledAddonIds(state.homeDir));

  return jsonResponse(200, { addons }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const body = result.data;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return errorResponse(400, "bad_request", "name is required", {}, requestId);

  if (!listAvailableAddonIds().includes(name)) {
    return errorResponse(404, "not_found", `Addon "${name}" is not available`, { name }, requestId);
  }

  const requestedEnabled: boolean | undefined = typeof body.enabled === "boolean" ? body.enabled : undefined;
  const toggle = await performAddonToggle(state, name, requestedEnabled, requestId);

  if (!toggle.ok) {
    return errorResponse(500, "internal_error", toggle.error, {}, requestId);
  }

  return jsonResponse(200, { ok: true, addon: name, enabled: toggle.enabled, changed: toggle.changed }, requestId);
};
