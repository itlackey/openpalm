import {
  getRequestId,
  jsonResponse,
  requireAdmin,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { applyUpdate, appendAudit, ensureSecrets, ensureXdgDirs, ensureOpenCodeConfig, buildComposeFileList, buildEnvFiles, buildManagedServices } from "$lib/server/control-plane.js";
import { composeUp, checkDocker } from "$lib/server/docker.js";
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
  ensureSecrets(state);
  const result = applyUpdate(state);

  // Re-apply compose with updated artifacts (include all channel overlays)
  const dockerCheck = await checkDocker();
  let dockerResult = null;
  if (dockerCheck.ok) {
    dockerResult = await composeUp(state.stateDir, {
      files: buildComposeFileList(state),
      envFiles: buildEnvFiles(state),
      services: buildManagedServices(state)
    });
  }

  appendAudit(
    state,
    actor,
    "update",
    { restarted: result.restarted, dockerAvailable: dockerCheck.ok },
    true,
    requestId,
    callerType
  );

  return jsonResponse(200, { ok: true, ...result, dockerAvailable: dockerCheck.ok }, requestId);
};
