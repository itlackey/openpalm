/**
 * POST /admin/config/sync/restore — Restore CONFIG_HOME to a previous snapshot.
 *
 * Body: { "snapshotId": "<provider-specific ID>" }
 *
 * secrets.env is never overwritten during restore.
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
  const snapshotId = body.snapshotId as string | undefined;

  if (!snapshotId || typeof snapshotId !== "string") {
    return errorResponse(400, "invalid_input", "snapshotId is required", {}, requestId);
  }

  // Basic safety check — reject obviously dangerous input while staying
  // provider-agnostic. Format validation is delegated to the provider.
  if (snapshotId.length > 256 || /[^a-zA-Z0-9._\-\/]/.test(snapshotId)) {
    return errorResponse(400, "invalid_input", "Invalid snapshot ID format", {}, requestId);
  }

  const provider = getProvider(state.configDir);
  const result = await provider.restore(state.configDir, snapshotId);

  appendAudit(
    state, actor, "config.sync.restore",
    { snapshotId, ok: result.ok, error: result.error ?? null },
    result.ok, requestId, callerType
  );

  if (!result.ok) {
    return errorResponse(500, "restore_failed", result.error ?? "Restore failed", {}, requestId);
  }

  return jsonResponse(200, { ok: true, restoredTo: snapshotId }, requestId);
};
