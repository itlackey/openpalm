import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  applyUpgrade,
  updateStackEnvToLatestImageTag,
  appendAudit,
  ensureXdgDirs,
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  ensureOpenMemoryPatch,
  ensureSecrets,
  buildComposeFileList,
  buildEnvFiles,
  buildManagedServices
} from "$lib/server/control-plane.js";
import { composePull, composeUp, checkDocker } from "$lib/server/docker.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  ensureXdgDirs();
  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig();
  ensureOpenMemoryPatch();
  ensureSecrets(state);

  let imageTag = "";
  try {
    const tagResult = await updateStackEnvToLatestImageTag(state);
    imageTag = tagResult.tag;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendAudit(state, actor, "upgrade", { result: "error", reason: "image_tag_update_failed", message: msg }, false, requestId, callerType);
    return errorResponse(502, "image_tag_update_failed", "Failed to update stack.env with the latest image tag", { message: msg }, requestId);
  }

  // 1. Download fresh assets, back up changed files, stage artifacts
  let upgradeResult;
  try {
    upgradeResult = await applyUpgrade(state);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendAudit(state, actor, "upgrade", { result: "error", reason: "asset_download_failed", message: msg }, false, requestId, callerType);
    return errorResponse(502, "asset_download_failed", msg, {}, requestId);
  }

  // 2. Docker: pull + up
  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    appendAudit(state, actor, "upgrade", { result: "error", reason: "docker_unavailable" }, false, requestId, callerType);
    return errorResponse(503, "docker_unavailable", "Docker is not available", { stderr: dockerCheck.stderr }, requestId);
  }

  const files = buildComposeFileList(state);
  const envFiles = buildEnvFiles(state);

  const pullResult = await composePull(state.stateDir, { files, envFiles });
  if (!pullResult.ok) {
    appendAudit(state, actor, "upgrade", { result: "error", reason: "pull_failed", stderr: pullResult.stderr }, false, requestId, callerType);
    return errorResponse(502, "pull_failed", "Failed to pull images", { stderr: pullResult.stderr }, requestId);
  }

  const upResult = await composeUp(state.stateDir, { files, envFiles, services: buildManagedServices(state) });
  if (!upResult.ok) {
    appendAudit(state, actor, "upgrade", { result: "error", reason: "up_failed", stderr: upResult.stderr }, false, requestId, callerType);
    return errorResponse(502, "up_failed", "Images pulled but failed to recreate containers", { stderr: upResult.stderr }, requestId);
  }

  appendAudit(state, actor, "upgrade", {
    result: "ok",
    imageTag,
    assetsUpdated: upgradeResult.updated,
    backupDir: upgradeResult.backupDir,
    restarted: upgradeResult.restarted
  }, true, requestId, callerType);

  return jsonResponse(200, {
    ok: true,
    imageTag,
    backupDir: upgradeResult.backupDir,
    assetsUpdated: upgradeResult.updated,
    restarted: upgradeResult.restarted
  }, requestId);
};
