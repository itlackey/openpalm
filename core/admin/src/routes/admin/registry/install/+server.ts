/**
 * POST /admin/registry/install — Install a registry item (channel or automation).
 *
 * Reads the item content from the cloned registry repo, then copies it into
 * CONFIG_HOME. For channels, also stages compose artifacts and starts Docker.
 * For automations, stages and reloads the scheduler.
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
  persistArtifacts,
  stageArtifacts,
  buildComposeFileList,
  buildEnvFiles,
  buildManagedServices,
  randomHex
} from "$lib/server/control-plane.js";
import {
  getRegistryChannel,
  getRegistryAutomation
} from "$lib/server/registry-sync.js";
import { composeUp, checkDocker } from "$lib/server/docker.js";
import { reloadScheduler } from "$lib/server/scheduler.js";

const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

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

  if (!name || typeof name !== "string" || !VALID_NAME_RE.test(name)) {
    return errorResponse(400, "invalid_input", "name is required and must be valid", {}, requestId);
  }
  if (type !== "channel" && type !== "automation") {
    return errorResponse(400, "invalid_input", "type must be 'channel' or 'automation'", {}, requestId);
  }

  if (type === "channel") {
    const entry = getRegistryChannel(name);
    if (!entry) {
      appendAudit(state, actor, "registry.install", { name, type, error: "not found" }, false, requestId, callerType);
      return errorResponse(400, "invalid_input", `Channel "${name}" not found in registry`, {}, requestId);
    }

    const channelsDir = `${state.configDir}/channels`;
    mkdirSync(channelsDir, { recursive: true });
    const ymlPath = `${channelsDir}/${name}.yml`;

    if (existsSync(ymlPath)) {
      return errorResponse(400, "invalid_input", `Channel "${name}" is already installed`, {}, requestId);
    }

    writeFileSync(ymlPath, entry.yml);
    if (entry.caddy) {
      writeFileSync(`${channelsDir}/${name}.caddy`, entry.caddy);
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
  const content = getRegistryAutomation(name);
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

  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);
  reloadScheduler(state.stateDir, state.adminToken);

  appendAudit(state, actor, "registry.install", { name, type }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, name, type }, requestId);
};
