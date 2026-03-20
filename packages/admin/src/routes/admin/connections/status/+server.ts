/**
 * GET /admin/connections/status — Check if the system LLM connection is configured.
 *
 * Returns { complete: boolean, missing: string[] }.
 * "complete" is true when a provider and system model are set.
 * API key is never required (optional for all providers).
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
  readSecretsEnvFile
} from "$lib/server/control-plane.js";
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const raw = readSecretsEnvFile(state.vaultDir);
  const missing: string[] = [];

  const provider = (raw.SYSTEM_LLM_PROVIDER ?? "").trim();
  const systemModel = (raw.SYSTEM_LLM_MODEL ?? "").trim();

  if (!provider) {
    missing.push("System LLM provider");
  }

  if (!systemModel) {
    missing.push("System model");
  }

  const complete = missing.length === 0;

  appendAudit(
    state, actor, "connections.status",
    { complete, missing },
    true, requestId, callerType
  );

  return jsonResponse(200, { complete, missing }, requestId);
};
