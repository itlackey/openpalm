import { getState } from "$lib/server/state.js";
import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { applyTagChange, checkDocker, createLogger, DowngradeConfirmationRequired } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("stack-version");

export const PATCH: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  let body: { tag?: string; confirmDowngrade?: boolean };
  try { body = await event.request.json(); } catch { return errorResponse(400, "invalid_json", "Request body must be valid JSON", {}, requestId); }

  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (!tag) return errorResponse(400, "tag_required", "tag is required", {}, requestId);
  if (!/^[a-zA-Z0-9._\-]+$/.test(tag)) return errorResponse(400, "invalid_tag", "Tag must be alphanumeric with . _ or - only", {}, requestId);
  const confirmDowngrade = body.confirmDowngrade === true;

  const state = getState();

  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    logger.error("stack-version aborted: docker unavailable", { requestId });
    return errorResponse(503, "docker_unavailable", "Docker is not available", { stderr: dockerCheck.stderr }, requestId);
  }

  let result;
  try {
    result = await applyTagChange(state, tag, { confirmDowngrade });
  } catch (e) {
    if (e instanceof DowngradeConfirmationRequired) {
      // Not an error condition — the UI shows a plain warning + confirm and
      // re-submits with confirmDowngrade:true. 409 = needs confirmation.
      logger.info("stack-version downgrade requires confirmation", { requestId, currentVersion: e.currentVersion, targetVersion: e.targetVersion });
      return errorResponse(409, "downgrade_confirmation_required", e.message, {
        currentVersion: e.currentVersion,
        targetVersion: e.targetVersion,
      }, requestId);
    }
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("stack-version apply failed", { requestId, error: msg });
    return errorResponse(502, "apply_failed", msg, { message: msg }, requestId);
  }

  logger.info("stack-version applied", { requestId, imageTag: result.imageTag });
  return jsonResponse(200, {
    ok: true,
    imageTag: result.imageTag,
    restarted: result.restarted,
  }, requestId);
};
