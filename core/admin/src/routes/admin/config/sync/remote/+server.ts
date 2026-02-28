/**
 * POST /admin/config/sync/remote — Configure the remote sync target.
 *
 * Body: { "url": "https://github.com/user/my-config.git" }
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
  const url = body.url as string | undefined;

  if (!url || typeof url !== "string") {
    return errorResponse(400, "invalid_input", "url is required", {}, requestId);
  }

  // Basic validation — must look like a URL or SSH remote
  const looksValid = url.startsWith("https://") || url.startsWith("http://")
    || url.startsWith("git@") || url.startsWith("ssh://");
  if (!looksValid) {
    return errorResponse(400, "invalid_input", "URL must start with https://, http://, git@, or ssh://", {}, requestId);
  }

  const provider = getProvider(state.configDir);
  const result = await provider.setRemote(state.configDir, url);

  appendAudit(
    state, actor, "config.sync.remote",
    { ok: result.ok, error: result.error ?? null },
    result.ok, requestId, callerType
  );

  if (!result.ok) {
    return errorResponse(500, "remote_failed", result.error ?? "Failed to set remote", {}, requestId);
  }

  return jsonResponse(200, { ok: true }, requestId);
};
