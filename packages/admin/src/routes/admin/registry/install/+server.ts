/**
 * POST /admin/registry/install — Install a registry item (automation only).
 *
 * Channel/component installation is handled via POST /api/instances.
 * This endpoint only handles automations from the registry.
 *
 * Tries the cloned registry repo first, falls back to bundled assets.
 * Copies content into CONFIG_HOME, writes runtime configuration.
 */
import type { RequestHandler } from "./$types";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType,
  parseJsonBody
} from "$lib/server/helpers.js";
import {
  appendAudit,
  writeRuntimeFiles,
  resolveRuntimeFiles,
  REGISTRY_AUTOMATION_YML
} from "$lib/server/control-plane.js";
import {
  getRegistryAutomation
} from "$lib/server/registry-sync.js";


const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, "invalid_input", "Request body must be valid JSON", {}, requestId);
  }
  const name = body.name as string | undefined;
  const type = body.type as string | undefined;

  if (!name || typeof name !== "string" || !VALID_NAME_RE.test(name)) {
    return errorResponse(400, "invalid_input", "name is required and must be valid", {}, requestId);
  }

  if (type === "channel") {
    return errorResponse(400, "invalid_input", "Channel installation is now handled via POST /api/instances. Use the component system instead.", {}, requestId);
  }

  if (type !== "automation") {
    return errorResponse(400, "invalid_input", "type must be 'automation'", {}, requestId);
  }

  // type === "automation"
  const remoteContent = getRegistryAutomation(name);
  const content = remoteContent ?? REGISTRY_AUTOMATION_YML[name] ?? null;

  if (!content) {
    appendAudit(state, actor, "registry.install", { name, type, error: "not found" }, false, requestId, callerType);
    return errorResponse(400, "invalid_input", `Automation "${name}" not found in registry`, {}, requestId);
  }

  const automationsDir = `${state.configDir}/automations`;
  mkdirSync(automationsDir, { recursive: true });
  const ymlPath = `${automationsDir}/${name}.yml`;

  if (existsSync(ymlPath)) {
    return errorResponse(400, "invalid_input", `Automation "${name}" is already installed`, {}, requestId);
  }

  writeFileSync(ymlPath, content);

  state.artifacts = resolveRuntimeFiles(state);
  writeRuntimeFiles(state);
  // Scheduler sidecar auto-reloads via file watching

  appendAudit(state, actor, "registry.install", { name, type }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, name, type }, requestId);
};
