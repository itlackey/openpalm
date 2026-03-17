/**
 * POST /admin/registry/install — Install a registry item (channel or automation).
 *
 * Tries the cloned registry repo first, falls back to bundled assets.
 * Copies content into CONFIG_HOME, stages compose artifacts, and starts Docker.
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
  randomHex,
  REGISTRY_CHANNEL_YML,
  REGISTRY_CHANNEL_CADDY,
  REGISTRY_AUTOMATION_YML
} from "$lib/server/control-plane.js";
import {
  getRegistryChannel,
  getRegistryAutomation
} from "$lib/server/registry-sync.js";
import { composeUp, checkDocker } from "$lib/server/docker.js";


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
  if (type !== "channel" && type !== "automation") {
    return errorResponse(400, "invalid_input", "type must be 'channel' or 'automation'", {}, requestId);
  }

  if (type === "channel") {
    // Try remote registry first, then bundled
    const remote = getRegistryChannel(name);
    const yml = remote?.yml ?? REGISTRY_CHANNEL_YML[name] ?? null;
    const caddy = remote?.caddy ?? REGISTRY_CHANNEL_CADDY[name] ?? null;

    if (!yml) {
      appendAudit(state, actor, "registry.install", { name, type, error: "not found" }, false, requestId, callerType);
      return errorResponse(400, "invalid_input", `Channel "${name}" not found in registry`, {}, requestId);
    }

    const channelsDir = `${state.configDir}/channels`;
    mkdirSync(channelsDir, { recursive: true });
    const ymlPath = `${channelsDir}/${name}.yml`;

    if (existsSync(ymlPath)) {
      return errorResponse(400, "invalid_input", `Channel "${name}" is already installed`, {}, requestId);
    }

    writeFileSync(ymlPath, yml);
    if (caddy) {
      writeFileSync(`${channelsDir}/${name}.caddy`, caddy);
    }

    if (!state.channelSecrets[name]) {
      state.channelSecrets[name] = randomHex(16);
    }

    state.services[`channel-${name}`] = "running";
    state.artifacts = stageArtifacts(state);
    persistArtifacts(state);
    // Scheduler sidecar auto-reloads via file watching

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

  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);
  // Scheduler sidecar auto-reloads via file watching

  appendAudit(state, actor, "registry.install", { name, type }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, name, type }, requestId);
};
