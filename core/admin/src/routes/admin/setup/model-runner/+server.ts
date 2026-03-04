/**
 * GET /admin/setup/model-runner
 *
 * Checks Docker Model Runner availability during setup wizard.
 * Uses the ephemeral setup token (not admin token) so it works
 * before the admin token has been configured.
 */
import {
  getRequestId,
  jsonResponse,
  errorResponse,
  safeTokenCompare
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  detectModelRunner,
  listPulledModels,
  SUGGESTED_SYSTEM_MODELS,
  SUGGESTED_EMBEDDING_MODELS,
  LOCAL_EMBEDDING_DIMS
} from "$lib/server/control-plane.js";
import { isSetupComplete } from "$lib/server/setup-status.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const state = getState();

  // During first-run: accept the ephemeral setup token.
  // After setup is complete: require normal admin auth.
  const setupComplete = isSetupComplete(state.stateDir, state.configDir);
  const token = event.request.headers.get("x-admin-token") ?? "";

  if (setupComplete) {
    // After setup, require admin token
    if (!safeTokenCompare(token, state.adminToken)) {
      return errorResponse(401, "unauthorized", "Missing or invalid x-admin-token", {}, requestId);
    }
  } else {
    // During setup, accept the setup token
    if (!safeTokenCompare(token, state.setupToken)) {
      return errorResponse(401, "unauthorized", "Missing or invalid setup token", {}, requestId);
    }
  }

  const detection = await detectModelRunner();

  const pulledModels = detection.available
    ? await listPulledModels(detection.url)
    : [];

  return jsonResponse(200, {
    modelRunnerAvailable: detection.available,
    modelRunnerUrl: detection.url,
    suggestedSystemModels: SUGGESTED_SYSTEM_MODELS,
    suggestedEmbeddingModels: SUGGESTED_EMBEDDING_MODELS,
    embeddingDims: LOCAL_EMBEDDING_DIMS,
    pulledModels,
  }, requestId);
};
