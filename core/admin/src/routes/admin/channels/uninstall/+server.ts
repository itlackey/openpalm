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
  buildEnvFiles,
  backupChannelConfig,
  rollbackChannelConfig,
  clearChannelConfigBackup
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
  const channel = body.channel as string | undefined;

  if (!channel || typeof channel !== "string") {
    return errorResponse(400, "invalid_input", "channel is required", {}, requestId);
  }

  const serviceName = `channel-${channel}`;

  // Backup channel files before deletion (enables rollback on staging failure)
  backupChannelConfig("uninstall", channel, state.configDir, state.stateDir);

  // Remove channel files from CONFIG_HOME
  const result = uninstallChannel(channel, state.configDir);
  if (!result.ok) {
    clearChannelConfigBackup(channel, state.stateDir);
    appendAudit(state, actor, "channels.uninstall", { channel, error: result.error }, false, requestId, callerType);
    return errorResponse(400, "invalid_input", result.error, {}, requestId);
  }

  // Save previous state for rollback
  const prevSecret = state.channelSecrets[channel];
  const prevServiceStatus = state.services[serviceName];

  // Remove channel secret and service from state
  delete state.channelSecrets[channel];
  delete state.services[serviceName];

  // Re-stage artifacts — rollback CONFIG_HOME on failure
  try {
    state.artifacts = stageArtifacts(state);
    persistArtifacts(state);
  } catch (err) {
    // Rollback: restore deleted channel files to CONFIG_HOME
    rollbackChannelConfig(channel, state.configDir, state.stateDir);
    if (prevSecret) state.channelSecrets[channel] = prevSecret;
    if (prevServiceStatus) state.services[serviceName] = prevServiceStatus;
    appendAudit(state, actor, "channels.uninstall", { channel, error: String(err) }, false, requestId, callerType);
    return errorResponse(500, "internal_error", "Failed to stage artifacts after uninstall", {}, requestId);
  }

  // Clear the config backup — staging succeeded
  clearChannelConfigBackup(channel, state.stateDir);

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
