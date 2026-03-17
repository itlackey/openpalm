/**
 * POST /admin/registry/uninstall — Uninstall a registry item (channel or automation).
 *
 * For channels: delegates to the existing channel uninstall flow.
 * For automations: removes the .yml from CONFIG_HOME/automations/,
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
  uninstallChannel,
  uninstallAutomation,
  persistArtifacts,
  stageArtifacts,
  buildComposeFileList,
  buildEnvFiles
} from "$lib/server/control-plane.js";
import { composeStop, checkDocker } from "$lib/server/docker.js";


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

  if (!name || typeof name !== "string") {
    return errorResponse(400, "invalid_input", "name is required", {}, requestId);
  }
  if (type !== "channel" && type !== "automation") {
    return errorResponse(400, "invalid_input", "type must be 'channel' or 'automation'", {}, requestId);
  }

  if (type === "channel") {
    const serviceName = `channel-${name}`;
    const result = uninstallChannel(name, state.configDir);
    if (!result.ok) {
      appendAudit(state, actor, "registry.uninstall", { name, type, error: result.error }, false, requestId, callerType);
      return errorResponse(400, "invalid_input", result.error, {}, requestId);
    }

    delete state.channelSecrets[name];
    delete state.services[serviceName];

    state.artifacts = stageArtifacts(state);
    persistArtifacts(state);
    // Scheduler sidecar auto-reloads via file watching

    const dockerCheck = await checkDocker();
    let dockerResult = null;
    if (dockerCheck.ok) {
      dockerResult = await composeStop(state.stateDir, [serviceName], {
        files: buildComposeFileList(state),
        envFiles: buildEnvFiles(state)
      });
    }

    appendAudit(state, actor, "registry.uninstall", { name, type }, true, requestId, callerType);
    return jsonResponse(200, {
      ok: true,
      name,
      type,
      dockerAvailable: dockerCheck.ok,
      composeResult: dockerResult ? { ok: dockerResult.ok, stderr: dockerResult.stderr } : null
    }, requestId);
  }

  // type === "automation"
  const result = uninstallAutomation(name, state.configDir);
  if (!result.ok) {
    appendAudit(state, actor, "registry.uninstall", { name, type, error: result.error }, false, requestId, callerType);
    return errorResponse(400, "invalid_input", result.error, {}, requestId);
  }

  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);
  // Scheduler sidecar auto-reloads via file watching

  appendAudit(state, actor, "registry.uninstall", { name, type }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, name, type }, requestId);
};
