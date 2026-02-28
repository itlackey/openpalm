/**
 * POST /admin/config/sync/snapshot — Create a manual config snapshot.
 *
 * Body: { "message": "optional description" }
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
import { appendAudit } from "$lib/server/control-plane.js";
import { getProvider } from "$lib/server/sync/index.js";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const body = await parseJsonBody(event.request);
  const message = typeof body.message === "string" && body.message
    ? body.message
    : `Manual snapshot — ${new Date().toISOString()}`;

  const provider = getProvider(state.configDir);
  const result = await provider.snapshot(state.configDir, message);

  appendAudit(
    state, actor, "config.sync.snapshot",
    { message, ok: result.ok, id: result.id ?? null, error: result.error ?? null },
    result.ok, requestId, callerType
  );

  if (!result.ok) {
    return errorResponse(500, "snapshot_failed", result.error ?? "Snapshot failed", {}, requestId);
  }

  return jsonResponse(200, { ok: true, id: result.id ?? null }, requestId);
};
