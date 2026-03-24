/**
 * GET  /admin/addons/:name — Return addon detail: enabled state, env overrides.
 * POST /admin/addons/:name — Enable/disable addon and/or update its env config.
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
} from "$lib/server/helpers.js";
import {
  appendAudit,
  readStackSpec,
  writeStackSpec,
  writeCapabilityVars,
  writeSystemEnv,
  hasAddon,
  isChannelAddon,
  randomHex,
  type StackSpecAddonValue,
} from "@openpalm/lib";
import { composeDown, checkDocker } from "$lib/server/docker.js";
import { createLogger } from "$lib/server/logger.js";
import { buildComposeFileList, buildEnvFiles } from "@openpalm/lib";
import { existsSync, readdirSync } from "node:fs";

/** List addon IDs by scanning the stack/addons/ directory on disk. */
function listAddonIds(homeDir: string): string[] {
  const addonsDir = `${homeDir}/stack/addons`;
  if (!existsSync(addonsDir)) return [];
  return readdirSync(addonsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

const logger = createLogger("addons.name");

function extractEnv(value: StackSpecAddonValue | undefined): Record<string, string> {
  if (value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)) {
    return value.env ?? {};
  }
  return {};
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
  const availableIds = listAddonIds(state.homeDir);
  if (!availableIds.includes(name)) {
    return errorResponse(404, "not_found", `Addon "${name}" is not available`, { name }, requestId);
  }

  const spec = readStackSpec(state.configDir);
  const enabled = spec ? hasAddon(spec, name) : false;
  const env = spec ? extractEnv(spec.addons[name]) : {};

  appendAudit(state, actor, "addons.name.get", { name }, true, requestId, callerType);
  return jsonResponse(200, { name, enabled, env }, requestId);
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
  const availableIds = listAddonIds(state.homeDir);
  if (!availableIds.includes(name)) {
    return errorResponse(404, "not_found", `Addon "${name}" is not available`, { name }, requestId);
  }

  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, "invalid_input", "Request body must be valid JSON", {}, requestId);
  }

  const spec = readStackSpec(state.configDir);
  if (!spec) {
    return errorResponse(500, "internal_error", "stack.yaml not found or invalid", {}, requestId);
  }

  const enabled: boolean | undefined =
    typeof body.enabled === "boolean" ? body.enabled : undefined;
  const envPatch: Record<string, string> | undefined =
    body.env !== null && body.env !== undefined && typeof body.env === "object" && !Array.isArray(body.env)
      ? (body.env as Record<string, string>)
      : undefined;

  const wasEnabled = hasAddon(spec, name);
  const existingEnv = extractEnv(spec.addons[name]);

  const newEnabled = enabled !== undefined ? enabled : wasEnabled;
  const newEnv = envPatch !== undefined ? { ...existingEnv, ...envPatch } : existingEnv;

  // Build the addon value: object with env if env is non-empty, otherwise boolean
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
    appendAudit(state, actor, "addons.name.post", { name, error: String(err) }, false, requestId, callerType);
    return errorResponse(500, "internal_error", "Failed to update stack.yaml", {}, requestId);
  }

  // Generate HMAC secret for newly-enabled channel addons
  if (newEnabled && !wasEnabled) {
    const composePath = `${state.homeDir}/stack/addons/${name}/compose.yml`;
    if (isChannelAddon(composePath)) {
      try {
        writeSystemEnv(state, { [name]: randomHex(16) });
        logger.info("generated HMAC secret for channel addon", { name, requestId });
      } catch (err) {
        logger.warn("failed to generate HMAC secret for channel addon", { name, error: String(err), requestId });
      }
    }
  }

  // On disable: optionally compose down the addon services
  if (!newEnabled && wasEnabled) {
    const dockerCheck = await checkDocker();
    if (dockerCheck.ok) {
      try {
        await composeDown({ files: buildComposeFileList(state), envFiles: buildEnvFiles(state) });
        logger.info("compose down after addon disable", { name, requestId });
      } catch (err) {
        logger.warn("compose down failed after addon disable", { name, error: String(err), requestId });
      }
    }
  }

  const changed = newEnabled !== wasEnabled;
  const resultEnabled = hasAddon(spec, name);
  const resultEnv = extractEnv(spec.addons[name]);

  appendAudit(state, actor, "addons.name.post", { name, enabled: resultEnabled, changed }, true, requestId, callerType);
  logger.info("addon updated", { name, enabled: resultEnabled, changed, requestId });

  return jsonResponse(200, { ok: true, addon: name, enabled: resultEnabled, changed }, requestId);
};
