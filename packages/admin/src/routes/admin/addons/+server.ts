/**
 * GET  /admin/addons — Return all available addons with enabled status and env config.
 * POST /admin/addons — Enable/disable an addon and/or update its env config.
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
  readStackSpec,
  writeStackSpec,
  writeCapabilityVars,
  writeChannelSecrets,
  hasAddon,
  addonNames,
  isChannelAddon,
  randomHex,
  type StackSpec,
  type StackSpecAddonValue,
} from "@openpalm/lib";
import { createLogger } from "$lib/server/logger.js";

const logger = createLogger("addons");

import { existsSync, readdirSync } from "node:fs";

/** List addon IDs by scanning the stack/addons/ directory on disk. */
function listAddonIds(homeDir: string): string[] {
  const addonsDir = `${homeDir}/stack/addons`;
  if (!existsSync(addonsDir)) return [];
  return readdirSync(addonsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

type AddonItem = {
  name: string;
  enabled: boolean;
  hasCompose: boolean;
  env: Record<string, string>;
};

function buildAddonList(spec: StackSpec | null, availableIds: string[], homeDir: string): AddonItem[] {
  return availableIds.map((name) => {
    const hasCompose = existsSync(`${homeDir}/stack/addons/${name}/compose.yml`);
    if (!spec) {
      return { name, enabled: false, hasCompose, env: {} };
    }
    const enabled = hasAddon(spec, name);
    const value: StackSpecAddonValue | undefined = spec.addons[name];
    const env =
      value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
        ? (value.env ?? {})
        : {};
    return { name, enabled, hasCompose, env };
  });
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const spec = readStackSpec(state.configDir);
  const availableIds = listAddonIds(state.homeDir);
  const addons = buildAddonList(spec, availableIds, state.homeDir);

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
  const availableIds = listAddonIds(state.homeDir);
  if (!availableIds.includes(name)) {
    return errorResponse(404, "not_found", `Addon "${name}" is not available`, { name }, requestId);
  }

  const spec = readStackSpec(state.configDir);
  if (!spec) {
    return errorResponse(500, "internal_error", "stack.yml not found or invalid", {}, requestId);
  }

  const enabled: boolean | undefined =
    typeof body.enabled === "boolean" ? body.enabled : undefined;
  const envPatch: Record<string, string> | undefined =
    body.env !== null && body.env !== undefined && typeof body.env === "object" && !Array.isArray(body.env)
      ? (body.env as Record<string, string>)
      : undefined;

  // Determine the new value for this addon
  const existing: StackSpecAddonValue | undefined = spec.addons[name];
  const existingEnv: Record<string, string> =
    existing !== null && existing !== undefined && typeof existing === "object" && !Array.isArray(existing)
      ? (existing.env ?? {})
      : {};

  const newEnabled = enabled !== undefined ? enabled : hasAddon(spec, name);
  const newEnv = envPatch !== undefined ? { ...existingEnv, ...envPatch } : existingEnv;

  let newValue: StackSpecAddonValue;
  if (Object.keys(newEnv).length > 0) {
    newValue = { env: newEnv };
  } else {
    newValue = newEnabled;
  }

  spec.addons[name] = newValue;

  try {
    writeStackSpec(state.configDir, spec);
    writeCapabilityVars(spec, state.vaultDir);
  } catch (err) {
    appendAudit(state, actor, "addons.post", { name, error: String(err) }, false, requestId, callerType);
    return errorResponse(500, "internal_error", "Failed to update stack.yml", {}, requestId);
  }

  // Generate HMAC secret for newly-enabled channel addons
  if (newEnabled) {
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

  const resultEnabled = hasAddon(spec, name);
  const resultValue: StackSpecAddonValue | undefined = spec.addons[name];
  const resultEnv: Record<string, string> =
    resultValue !== null && resultValue !== undefined && typeof resultValue === "object" && !Array.isArray(resultValue)
      ? (resultValue.env ?? {})
      : {};

  appendAudit(state, actor, "addons.post", { name, enabled: resultEnabled }, true, requestId, callerType);
  logger.info("addon updated", { name, enabled: resultEnabled, requestId });

  return jsonResponse(200, { ok: true, addon: name, enabled: resultEnabled, changed: true }, requestId);
};
