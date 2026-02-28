/**
 * GET  /admin/connections — Return current connection config values (masked).
 * POST /admin/connections — Patch secrets.env with provided connection keys.
 *
 * Only keys in ALLOWED_CONNECTION_KEYS are readable/writable via this endpoint.
 * API key values are masked (all but last 4 chars) in GET responses.
 * Non-secret config keys (GUARDIAN_LLM_PROVIDER, GUARDIAN_LLM_MODEL) are returned as-is.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType,
  parseJsonBody
} from "$lib/server/helpers.js";
import {
  appendAudit,
  readSecretsEnvFile,
  patchSecretsEnvFile,
  ALLOWED_CONNECTION_KEYS,
  maskConnectionValue
} from "$lib/server/control-plane.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const raw = readSecretsEnvFile(state.configDir);
  const connections: Record<string, string> = {};
  for (const key of ALLOWED_CONNECTION_KEYS) {
    const value = raw[key] ?? "";
    connections[key] = maskConnectionValue(key, value);
  }

  appendAudit(state, actor, "connections.get", {}, true, requestId, callerType);
  return jsonResponse(200, { connections }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const body = await parseJsonBody(event.request);

  // Only forward allowed keys
  const patches: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED_CONNECTION_KEYS.has(key) && typeof value === "string") {
      patches[key] = value;
    }
  }

  if (Object.keys(patches).length === 0) {
    return errorResponse(400, "bad_request", "No valid connection keys provided", {}, requestId);
  }

  try {
    patchSecretsEnvFile(state.configDir, patches);
  } catch (err) {
    appendAudit(
      state,
      actor,
      "connections.patch",
      { keys: Object.keys(patches), error: String(err) },
      false,
      requestId,
      callerType
    );
    return errorResponse(
      500,
      "internal_error",
      "Failed to update secrets.env",
      {},
      requestId
    );
  }

  appendAudit(
    state,
    actor,
    "connections.patch",
    { keys: Object.keys(patches) },
    true,
    requestId,
    callerType
  );
  return jsonResponse(200, { ok: true, updated: Object.keys(patches) }, requestId);
};
