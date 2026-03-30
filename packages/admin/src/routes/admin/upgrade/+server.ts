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
  performUpgrade,
  appendAudit,
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  ensureMemoryDir,
  ensureSecrets,
  buildComposeOptions,
  ensureHomeDirs,
} from "@openpalm/lib";
import { checkDocker, selfRecreateAdmin } from "$lib/server/docker.js";
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

  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    appendAudit(state, actor, "upgrade", { result: "error", reason: "docker_unavailable" }, false, requestId, callerType);
    return errorResponse(503, "docker_unavailable", "Docker is not available", { stderr: dockerCheck.stderr }, requestId);
  }

  let result;
  try {
    result = await performUpgrade(state);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("upgrade failed", { requestId, error: msg });
    appendAudit(state, actor, "upgrade", { result: "error", message: msg }, false, requestId, callerType);
    return errorResponse(502, "upgrade_failed", msg, { message: msg }, requestId);
  }

  appendAudit(state, actor, "upgrade", {
    result: "ok",
    imageTag: result.imageTag,
    assetsUpdated: result.assetsUpdated,
    backupDir: result.backupDir,
    restarted: result.restarted
  }, true, requestId, callerType);

  logger.info("upgrade completed, scheduling admin self-recreation", { requestId, imageTag: result.imageTag, assetsUpdated: result.assetsUpdated });

  // Schedule deferred self-recreation of the admin container so the HTTP
  // response is flushed before Docker replaces this container.
  const { files, envFiles } = buildComposeOptions(state);
  setTimeout(() => {
    logger.info("recreating admin container with new image", { requestId, imageTag: result.imageTag });
    selfRecreateAdmin({ files, envFiles });
  }, 2_000);

  return jsonResponse(200, {
    ok: true,
    imageTag: result.imageTag,
    backupDir: result.backupDir,
    assetsUpdated: result.assetsUpdated,
    restarted: result.restarted,
    adminRecreateScheduled: true
  }, requestId);
};
