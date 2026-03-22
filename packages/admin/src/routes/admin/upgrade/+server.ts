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
  buildManagedServices,
  ensureHomeDirs,
} from "@openpalm/lib";
import { composePull, composeUp, checkDocker, selfRecreateAdmin } from "$lib/server/docker.js";
import { composePreflight } from "@openpalm/lib";
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

  // 1. Preflight: validate compose merge BEFORE any mutation
  const files = buildComposeFileList(state);
  const envFiles = buildEnvFiles(state);

  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    appendAudit(state, actor, "upgrade", { result: "error", reason: "docker_unavailable" }, false, requestId, callerType);
    return errorResponse(503, "docker_unavailable", "Docker is not available", { stderr: dockerCheck.stderr }, requestId);
  }

  if (files.length > 0) {
    const preflight = await composePreflight({ files, envFiles });
    if (!preflight.ok) {
      appendAudit(state, actor, "upgrade", { result: "error", reason: "preflight_failed", stderr: preflight.stderr }, false, requestId, callerType);
      return errorResponse(400, "preflight_failed", `Compose preflight failed: ${preflight.stderr}`, {}, requestId);
    }
  }

  // 2. Snapshot stack.env so we can restore on failure
  const stackEnvPath = `${state.vaultDir}/stack/stack.env`;
  let originalStackEnv: string | null = null;
  try {
    const { readFileSync } = await import("node:fs");
    originalStackEnv = readFileSync(stackEnvPath, "utf-8");
  } catch { /* stack.env may not exist yet */ }

  // 3. Mutate: update image tag + download fresh assets
  let imageTag = "";
  let upgradeResult: { backupDir: string | null; updated: string[]; restarted: string[] };
  try {
    logger.info("updating stack.env with latest image tag", { requestId });
    const tagResult = await updateStackEnvToLatestImageTag(state);
    imageTag = tagResult.tag;
    logger.info("image tag resolved", { requestId, imageTag });

    logger.info("downloading fresh assets and writing runtime files", { requestId });
    upgradeResult = await applyUpgrade(state);
    logger.info("runtime files written", { requestId, updated: upgradeResult.updated });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("upgrade failed, restoring stack.env", { requestId, error: msg });

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
    const detail = imageTag ? msg : "Failed to update stack.env with the latest image tag";
    appendAudit(state, actor, "upgrade", { result: "error", reason, message: msg }, false, requestId, callerType);
    return errorResponse(502, reason, detail, { message: msg }, requestId);
  }

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
