/**
 * GET /admin/providers/local
 *
 * Detect available local LLM providers (Docker Model Runner, Ollama, LM Studio).
 * Returns availability and base URL for each.
 *
 * Auth: setup token during wizard, admin token after setup.
 */
import {
  getRequestId,
  jsonResponse,
  errorResponse,
  safeTokenCompare
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { detectLocalProviders } from "$lib/server/control-plane.js";
import { isSetupComplete } from "$lib/server/setup-status.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const state = getState();

  const setupComplete = isSetupComplete(state.stateDir, state.configDir);
  const token = event.request.headers.get("x-admin-token") ?? "";

  if (setupComplete) {
    if (!safeTokenCompare(token, state.adminToken)) {
      return errorResponse(401, "unauthorized", "Missing or invalid x-admin-token", {}, requestId);
    }
  } else {
    if (!safeTokenCompare(token, state.setupToken)) {
      return errorResponse(401, "unauthorized", "Missing or invalid setup token", {}, requestId);
    }
  }

  const providers = await detectLocalProviders();
  return jsonResponse(200, { providers }, requestId);
};
