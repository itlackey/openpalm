/**
 * POST /admin/registry/install — Install a registry item (channel or automation).
 *
 * For channels: delegates to the existing channel install flow.
 * For automations: copies the .yml from registry into CONFIG_HOME/automations/,
 * re-stages artifacts, and reloads the scheduler.
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
  parseJsonBody
} from "$lib/server/helpers.js";
import {
  appendAudit,
  installChannelFromRegistry,
  installAutomationFromRegistry,
  persistArtifacts,
  stageArtifacts,
  buildComposeFileList,
  buildEnvFiles,
  buildManagedServices,
  randomHex
} from "$lib/server/control-plane.js";
import { composeUp, checkDocker } from "$lib/server/docker.js";
import { reloadScheduler } from "$lib/server/scheduler.js";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const body = await parseJsonBody(event.request);
  const name = body.name as string | undefined;
  const type = body.type as string | undefined;

  if (!name || typeof name !== "string") {
    return errorResponse(400, "invalid_input", "name is required", {}, requestId);
  }
  if (type !== "channel" && type !== "automation") {
    return errorResponse(400, "invalid_input", "type must be 'channel' or 'automation'", {}, requestId);
  }

  if (type === "channel") {
    const result = installChannelFromRegistry(name, state.configDir);
    if (!result.ok) {
      appendAudit(state, actor, "registry.install", { name, type, error: result.error }, false, requestId, callerType);
      return errorResponse(400, "invalid_input", result.error, {}, requestId);
    }

    if (!state.channelSecrets[name]) {
      state.channelSecrets[name] = randomHex(16);
    }

    state.services[`channel-${name}`] = "running";
    state.artifacts = stageArtifacts(state);
    persistArtifacts(state);
    reloadScheduler(state.stateDir, state.adminToken);

    const dockerCheck = await checkDocker();
    let dockerResult = null;
    if (dockerCheck.ok) {
      dockerResult = await composeUp(state.stateDir, {
        files: buildComposeFileList(state),
        envFiles: buildEnvFiles(state),
        services: buildManagedServices(state)
      });
    }

    appendAudit(state, actor, "registry.install", { name, type }, true, requestId, callerType);
    return jsonResponse(200, {
      ok: true,
      name,
      type,
      dockerAvailable: dockerCheck.ok,
      composeResult: dockerResult ? { ok: dockerResult.ok, stderr: dockerResult.stderr } : null
    }, requestId);
  }

  // type === "automation"
  const result = installAutomationFromRegistry(name, state.configDir);
  if (!result.ok) {
    appendAudit(state, actor, "registry.install", { name, type, error: result.error }, false, requestId, callerType);
    return errorResponse(400, "invalid_input", result.error, {}, requestId);
  }

  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);
  reloadScheduler(state.stateDir, state.adminToken);

  appendAudit(state, actor, "registry.install", { name, type }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, name, type }, requestId);
};
