/**
 * POST /admin/channels/uninstall — Uninstall a channel.
 *
 * Removes channel files from CONFIG_HOME/channels/, removes the service
 * from state, re-stages artifacts, and runs compose down for the service.
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
  persistArtifacts,
  stageArtifacts,
  buildComposeFileList,
  buildEnvFiles
} from "$lib/server/control-plane.js";
import { composeStop, checkDocker } from "$lib/server/docker.js";
import { reloadScheduler } from "$lib/server/scheduler.js";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const body = await parseJsonBody(event.request);
  const channel = body.channel as string | undefined;

  if (!channel || typeof channel !== "string") {
    return errorResponse(400, "invalid_input", "channel is required", {}, requestId);
  }

  const serviceName = `channel-${channel}`;

  // Remove channel files from CONFIG_HOME
  const result = uninstallChannel(channel, state.configDir);
  if (!result.ok) {
    appendAudit(state, actor, "channels.uninstall", { channel, error: result.error }, false, requestId, callerType);
    return errorResponse(400, "invalid_input", result.error, {}, requestId);
  }

  // Remove channel secret and service from state
  delete state.channelSecrets[channel];
  delete state.services[serviceName];

  // Re-stage artifacts
  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);
  reloadScheduler(state.stateDir, state.adminToken);

  // Stop the channel service
  const dockerCheck = await checkDocker();
  let dockerResult = null;
  if (dockerCheck.ok) {
    dockerResult = await composeStop(state.stateDir, [serviceName], {
      files: buildComposeFileList(state),
      envFiles: buildEnvFiles(state)
    });
  }

  appendAudit(
    state,
    actor,
    "channels.uninstall",
    { channel, dockerAvailable: dockerCheck.ok, composeResult: dockerResult?.ok ?? null },
    true,
    requestId,
    callerType
  );

  return jsonResponse(200, {
    ok: true,
    channel,
    service: serviceName,
    dockerAvailable: dockerCheck.ok,
    composeResult: dockerResult
      ? { ok: dockerResult.ok, stderr: dockerResult.stderr }
      : null
  }, requestId);
};
