import {
  getRequestId,
  jsonResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  applyUpdate,
  createLogger,
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  buildComposeOptions,
  buildManagedServices,
  ensureHomeDirs,
  composeUp,
  checkDocker,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("update");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("update request received", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();

  ensureHomeDirs();
  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig();
  // OpenCode session logs are the audit trail (D6a).
  const result = await applyUpdate(state);
  logger.info("update applied, re-running compose", { requestId, restarted: result.restarted });

  // Re-apply compose with updated artifacts (include all channel overlays)
  const dockerCheck = await checkDocker();
  let dockerResult = null;
  if (dockerCheck.ok) {
    dockerResult = await composeUp({
      ...buildComposeOptions(state),
      services: await buildManagedServices(state)
    });
  }

  logger.info("update completed", { requestId, dockerAvailable: dockerCheck.ok });
  return jsonResponse(200, { ok: true, ...result, dockerAvailable: dockerCheck.ok }, requestId);
};
