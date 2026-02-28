/**
 * POST /admin/channels/install — Install a channel from the registry.
 *
 * Copies channel files from the bundled registry catalog into
 * CONFIG_HOME/channels/, generates an HMAC secret if needed,
 * re-stages artifacts, and runs compose up.
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
  persistArtifacts,
  stageArtifacts,
  buildComposeFileList,
  buildEnvFiles,
  randomHex,
  backupChannelConfig,
  rollbackChannelConfig,
  clearChannelConfigBackup
} from "$lib/server/control-plane.js";
import { composeUp, checkDocker } from "$lib/server/docker.js";

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

  // Record intent before modifying CONFIG_HOME (enables rollback on failure)
  backupChannelConfig("install", channel, state.configDir, state.stateDir);

  // Install channel files from registry to CONFIG_HOME
  const result = installChannelFromRegistry(channel, state.configDir);
  if (!result.ok) {
    clearChannelConfigBackup(channel, state.stateDir);
    appendAudit(state, actor, "channels.install", { channel, error: result.error }, false, requestId, callerType);
    return errorResponse(400, "invalid_input", result.error, {}, requestId);
  }

  // Generate HMAC secret for the new channel if it doesn't have one
  if (!state.channelSecrets[channel]) {
    state.channelSecrets[channel] = randomHex(16);
  }

  // Re-stage artifacts and update state — rollback CONFIG_HOME on failure
  try {
    state.services[`channel-${channel}`] = "running";
    state.artifacts = stageArtifacts(state);
    persistArtifacts(state);
  } catch (err) {
    // Rollback: remove newly installed channel files from CONFIG_HOME
    rollbackChannelConfig(channel, state.configDir, state.stateDir);
    delete state.channelSecrets[channel];
    delete state.services[`channel-${channel}`];
    appendAudit(state, actor, "channels.install", { channel, error: String(err) }, false, requestId, callerType);
    return errorResponse(500, "internal_error", "Failed to stage artifacts after install", {}, requestId);
  }

  // Clear the config backup — staging succeeded
  clearChannelConfigBackup(channel, state.stateDir);

  // Run docker compose up
  const dockerCheck = await checkDocker();
  let dockerResult = null;
  if (dockerCheck.ok) {
    dockerResult = await composeUp(state.stateDir, {
      files: buildComposeFileList(state),
      envFiles: buildEnvFiles(state)
    });
  }

  appendAudit(
    state,
    actor,
    "channels.install",
    { channel, dockerAvailable: dockerCheck.ok, composeResult: dockerResult?.ok ?? null },
    true,
    requestId,
    callerType
  );

  return jsonResponse(200, {
    ok: true,
    channel,
    service: `channel-${channel}`,
    dockerAvailable: dockerCheck.ok,
    composeResult: dockerResult
      ? { ok: dockerResult.ok, stderr: dockerResult.stderr }
      : null
  }, requestId);
};
