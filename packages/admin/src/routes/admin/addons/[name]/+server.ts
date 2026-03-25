/**
 * GET  /admin/addons/:name — Return addon detail.
 * POST /admin/addons/:name — Enable or disable an addon.
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
import { composeStop, checkDocker } from "$lib/server/docker.js";
import { createLogger } from "$lib/server/logger.js";
import { buildComposeOptions } from "@openpalm/lib";
import { readFileSync } from "node:fs";

const logger = createLogger("addons.name");

function readAddonConfig(homeDir: string, name: string): {
  schemaPath: string;
  userEnvPath: string;
  envSchema: string;
} {
  const schemaPath = `registry/addons/${name}/.env.schema`;
  return {
    schemaPath,
    userEnvPath: 'vault/user/user.env',
    envSchema: readFileSync(`${homeDir}/${schemaPath}`, 'utf-8'),
  };
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const name = event.params.name;

  // Validate name is a known addon
  const availableIds = listAvailableAddonIds();
  if (!availableIds.includes(name)) {
    return errorResponse(404, "not_found", `Addon "${name}" is not available`, { name }, requestId);
  }

  const enabled = listEnabledAddonIds(state.homeDir).includes(name);
  let config;
  try {
    config = readAddonConfig(state.homeDir, name);
  } catch (error) {
    logger.error("failed to read addon schema", { name, error: String(error), requestId });
    return errorResponse(500, "internal_error", `Addon \"${name}\" schema is unavailable`, {}, requestId);
  }

  appendAudit(state, actor, "addons.name.get", { name }, true, requestId, callerType);
  return jsonResponse(200, { name, enabled, config }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const name = event.params.name;

  // Validate name is a known addon
  const availableIds = listAvailableAddonIds();
  if (!availableIds.includes(name)) {
    return errorResponse(404, "not_found", `Addon "${name}" is not available`, { name }, requestId);
  }

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const body = result.data;

  const enabled: boolean | undefined =
    typeof body.enabled === "boolean" ? body.enabled : undefined;
  const wasEnabled = listEnabledAddonIds(state.homeDir).includes(name);
  const newEnabled = enabled !== undefined ? enabled : wasEnabled;

  const mutation = newEnabled ? enableAddon(state.homeDir, name) : disableAddonByName(state.homeDir, name);
  if (!mutation.ok) {
    appendAudit(state, actor, "addons.name.post", { name, error: mutation.error }, false, requestId, callerType);
    return errorResponse(500, "internal_error", mutation.error, {}, requestId);
  }

  // Generate HMAC secret for newly-enabled channel addons
  if (newEnabled && !wasEnabled) {
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

  // On disable: stop only the disabled addon's services (not the whole stack)
  if (!newEnabled && wasEnabled) {
    const dockerCheck = await checkDocker();
    if (dockerCheck.ok) {
      try {
        await composeStop([name], buildComposeOptions(state));
        logger.info("stopped addon service after disable", { name, requestId });
      } catch (err) {
        logger.warn("failed to stop addon service after disable", { name, error: String(err), requestId });
      }
    }
  }

  const changed = newEnabled !== wasEnabled;
  const resultEnabled = listEnabledAddonIds(state.homeDir).includes(name);

  appendAudit(state, actor, "addons.name.post", { name, enabled: resultEnabled, changed }, true, requestId, callerType);
  logger.info("addon updated", { name, enabled: resultEnabled, changed, requestId });

  return jsonResponse(200, { ok: true, addon: name, enabled: resultEnabled, changed }, requestId);
};
