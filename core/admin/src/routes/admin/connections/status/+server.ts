/**
 * GET /admin/connections/status — Check if required LLM connections are configured.
 *
 * Returns { complete: boolean, missing: string[] }.
 * "complete" is true when at least one LLM provider API key is set.
 * "missing" lists required provider keys that are not set.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import {
  appendAudit,
  readSecretsEnvFile,
  REQUIRED_LLM_PROVIDER_KEYS
} from "$lib/server/control-plane.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const raw = readSecretsEnvFile(state.configDir);

  // Determine which required provider keys are missing (empty or absent)
  const missing = REQUIRED_LLM_PROVIDER_KEYS.filter(
    (key) => !raw[key] || raw[key].trim() === ""
  );

  // Complete = at least one provider key is set
  const complete = missing.length < REQUIRED_LLM_PROVIDER_KEYS.length;

  appendAudit(
    state,
    actor,
    "connections.status",
    { complete, missing },
    true,
    requestId,
    callerType
  );

  return jsonResponse(200, { complete, missing }, requestId);
};
