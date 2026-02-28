/**
 * POST /admin/config/sync/init — Initialize the sync backend in CONFIG_HOME.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { appendAudit } from "$lib/server/control-plane.js";
import { getProvider } from "$lib/server/sync/index.js";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const provider = getProvider(state.configDir);
  const result = await provider.init(state.configDir);

  appendAudit(
    state, actor, "config.sync.init",
    { provider: provider.name, ok: result.ok, error: result.error ?? null },
    result.ok, requestId, callerType
  );

  if (!result.ok) {
    return errorResponse(500, "sync_init_failed", result.error ?? "Init failed", {}, requestId);
  }

  return jsonResponse(200, { ok: true, provider: provider.name }, requestId);
};
