/**
 * GET  /api/host/addons — Return available addons with enabled status.
 * POST /api/host/addons — Enable or disable an addon.
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
  listAvailableAddonIds,
  listEnabledAddonIds,
} from "@openpalm/lib";
import { handleAddonToggleRequest } from "$lib/server/addon-helpers.js";
import { voiceAddonInfo } from "$lib/server/voice/bring-up.js";

type AddonItem = { name: string; enabled: boolean; available: boolean };

function buildAddonList(availableIds: string[], enabledIds: string[]): AddonItem[] {
  const enabledSet = new Set(enabledIds);
  return availableIds.map((name) => ({ name, enabled: enabledSet.has(name), available: true }));
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:addons', requestId);
  if (capabilityError) return capabilityError;
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const availableIds = listAvailableAddonIds();
  const addons = buildAddonList(availableIds, listEnabledAddonIds(state.homeDir));

  // The voice addon carries a hardware profile (CPU/CUDA/ROCm) and can have a
  // background bring-up job in flight — surface both so the Add-ons tab can
  // render the profile picker and poll pull/start progress.
  const voice = await voiceAddonInfo(state.homeDir);

  return jsonResponse(200, { addons, voice }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:addons', requestId);
  if (capabilityError) return capabilityError;
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

  return handleAddonToggleRequest(state, name, body, requestId);
};
