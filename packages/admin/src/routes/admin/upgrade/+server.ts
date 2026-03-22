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
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  ensureMemoryDir,
  ensureSecrets,
  buildComposeFileList,
  buildEnvFiles,
  buildManagedServices
} from "$lib/server/control-plane.js";
import { ensureHomeDirs } from "@openpalm/lib";
import { composePull, composeUp, checkDocker, selfRecreateAdmin } from "$lib/server/docker.js";
import { createLogger } from "$lib/server/logger.js";
import type { RequestHandler } from "./$types";

const logger = createLogger("upgrade");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("upgrade request received", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  ensureHomeDirs();
  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig();
  ensureMemoryDir();
  ensureSecrets(state);

  // Snapshot the current stack.env so we can restore on failure.
  // Both updateStackEnvToLatestImageTag and applyUpgrade mutate state;
  // if either fails, the original stack.env is restored to avoid a
  // half-applied upgrade.
  const stackEnvPath = `${state.vaultDir}/stack/stack.env`;
  let originalStackEnv: string | null = null;
  try {
    const { readFileSync } = await import("node:fs");
    originalStackEnv = readFileSync(stackEnvPath, "utf-8");
  } catch { /* stack.env may not exist yet */ }

  let imageTag = "";
  let upgradeResult: { backupDir: string | null; updated: string[]; restarted: string[] };
  try {
    logger.info("updating stack.env with latest image tag", { requestId });
    const tagResult = await updateStackEnvToLatestImageTag(state);
    imageTag = tagResult.tag;
    logger.info("image tag resolved", { requestId, imageTag });

    // 1. Download fresh assets, back up changed files, stage artifacts
    logger.info("downloading fresh assets and staging artifacts", { requestId });
    upgradeResult = await applyUpgrade(state);
    logger.info("assets staged", { requestId, updated: upgradeResult.updated });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("upgrade staging failed, restoring stack.env", { requestId, error: msg });

    // Restore original stack.env to avoid half-applied state
    if (originalStackEnv !== null) {
      try {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(stackEnvPath, originalStackEnv);
        logger.info("stack.env restored to pre-upgrade state", { requestId });
      } catch (restoreErr) {
        logger.error("failed to restore stack.env", { requestId, error: String(restoreErr) });
      }
    }

    const reason = imageTag ? "asset_download_failed" : "image_tag_update_failed";
    const detail = imageTag
      ? msg
      : "Failed to update stack.env with the latest image tag";
    appendAudit(state, actor, "upgrade", { result: "error", reason, message: msg }, false, requestId, callerType);
    return errorResponse(502, reason, detail, { message: msg }, requestId);
  }

  // 2. Docker: pull + up
  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    appendAudit(state, actor, "upgrade", { result: "error", reason: "docker_unavailable" }, false, requestId, callerType);
    return errorResponse(503, "docker_unavailable", "Docker is not available", { stderr: dockerCheck.stderr }, requestId);
  }

  const files = buildComposeFileList(state);
  const envFiles = buildEnvFiles(state);

  logger.info("pulling images", { requestId });
  const pullResult = await composePull({ files, envFiles });
  if (!pullResult.ok) {
    logger.error("image pull failed", { requestId, stderr: pullResult.stderr });
    appendAudit(state, actor, "upgrade", { result: "error", reason: "pull_failed", stderr: pullResult.stderr }, false, requestId, callerType);
    return errorResponse(502, "pull_failed", "Failed to pull images", { stderr: pullResult.stderr }, requestId);
  }

  logger.info("recreating containers", { requestId });
  const upResult = await composeUp({ files, envFiles, services: await buildManagedServices(state), removeOrphans: true });
  if (!upResult.ok) {
    logger.error("compose up failed after pull", { requestId, stderr: upResult.stderr });
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

  logger.info("upgrade completed, scheduling admin self-recreation", { requestId, imageTag, assetsUpdated: upgradeResult.updated });

  // Schedule deferred self-recreation of the admin container so the HTTP
  // response is flushed before Docker replaces this container.
  setTimeout(() => {
    logger.info("recreating admin container with new image", { requestId, imageTag });
    selfRecreateAdmin({ files, envFiles });
  }, 2_000);

  return jsonResponse(200, {
    ok: true,
    imageTag,
    backupDir: upgradeResult.backupDir,
    assetsUpdated: upgradeResult.updated,
    restarted: upgradeResult.restarted,
    adminRecreateScheduled: true
  }, requestId);
};
