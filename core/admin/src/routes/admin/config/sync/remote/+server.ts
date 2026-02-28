/**
 * POST /admin/config/sync/remote — Configure the remote sync target.
 *
 * Body: { "url": "<remote URL or directory path>" }
 *
 * For the git provider this is a repository URL (https://, git@, ssh://).
 * For the tar provider this is a local directory path.
 * The value is persisted to config.json → .sync.remoteUrl and also
 * forwarded to the provider's setRemote() for any provider-specific setup.
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
import { getProvider, readSyncConfig, writeSyncConfig } from "$lib/server/sync/index.js";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const body = await parseJsonBody(event.request);
  const url = body.url as string | undefined;

  if (!url || typeof url !== "string" || !url.trim()) {
    return errorResponse(400, "invalid_input", "url is required", {}, requestId);
  }

  // Persist remoteUrl to config.json
  const config = readSyncConfig(state.configDir);
  config.remoteUrl = url.trim();
  writeSyncConfig(state.configDir, config);

  // Forward to the provider for any provider-specific setup (e.g. git remote add)
  const provider = getProvider(state.configDir);
  const result = await provider.setRemote(state.configDir, url.trim());

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
