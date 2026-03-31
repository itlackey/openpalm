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
  getActor,
  getCallerType,
  parseJsonBody,
  jsonBodyError,
} from "$lib/server/helpers.js";
import {
  appendAudit,
  listAvailableAddonIds,
  listEnabledAddonIds,
  enableAddon,
  disableAddonByName,
  writeChannelSecrets,
  isChannelAddon,
  randomHex,
} from "@openpalm/lib";
import { createLogger } from "$lib/server/logger.js";

const logger = createLogger("addons");

type AddonItem = {
  name: string;
  enabled: boolean;
  available: boolean;
};

function buildAddonList(availableIds: string[], enabledIds: string[]): AddonItem[] {
  const enabledSet = new Set(enabledIds);
  return availableIds.map((name) => ({
    name,
    enabled: enabledSet.has(name),
    available: true,
  }));
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const availableIds = listAvailableAddonIds();
  const addons = buildAddonList(availableIds, listEnabledAddonIds(state.homeDir));

  appendAudit(state, actor, "addons.get", {}, true, requestId, callerType);
  return jsonResponse(200, { addons }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const body = result.data;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return errorResponse(400, "bad_request", "name is required", {}, requestId);
  }

  // Validate name is a known addon
  const availableIds = listAvailableAddonIds();
  if (!availableIds.includes(name)) {
    return errorResponse(404, "not_found", `Addon "${name}" is not available`, { name }, requestId);
  }

  const enabled: boolean | undefined =
    typeof body.enabled === "boolean" ? body.enabled : undefined;
  const wasEnabled = listEnabledAddonIds(state.homeDir).includes(name);
  const nextEnabled = enabled !== undefined ? enabled : wasEnabled;

  const mutation = nextEnabled ? enableAddon(state.homeDir, name) : disableAddonByName(state.homeDir, name);
  if (!mutation.ok) {
    appendAudit(state, actor, "addons.post", { name, error: mutation.error }, false, requestId, callerType);
    return errorResponse(500, "internal_error", mutation.error, {}, requestId);
  }

  // Generate HMAC secret for newly-enabled channel addons
  if (nextEnabled && !wasEnabled) {
    const composePath = `${state.homeDir}/stack/addons/${name}/compose.yml`;
    if (isChannelAddon(composePath)) {
      try {
        writeChannelSecrets(state.vaultDir, { [name]: randomHex(16) });
        logger.info("generated HMAC secret for channel addon", { name, requestId });
      } catch (err) {
        logger.warn("failed to generate HMAC secret for channel addon", { name, error: String(err), requestId });
      }
    }
  }

  const resultEnabled = listEnabledAddonIds(state.homeDir).includes(name);

  appendAudit(state, actor, "addons.post", { name, enabled: resultEnabled }, true, requestId, callerType);
  logger.info("addon updated", { name, enabled: resultEnabled, requestId });

  return jsonResponse(200, { ok: true, addon: name, enabled: resultEnabled, changed: true }, requestId);
};
