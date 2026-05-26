import { getState } from "$lib/server/state.js";
import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { applyTagChange, checkDocker, createLogger } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("stack-version");

export const PATCH: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  let body: { tag?: string };
  try { body = await event.request.json(); } catch { return errorResponse(400, "invalid_json", "Request body must be valid JSON", {}, requestId); }

  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (!tag) return errorResponse(400, "tag_required", "tag is required", {}, requestId);
  if (!/^[a-zA-Z0-9._\-]+$/.test(tag)) return errorResponse(400, "invalid_tag", "Tag must be alphanumeric with . _ or - only", {}, requestId);

  const state = getState();

  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    logger.error("stack-version aborted: docker unavailable", { requestId });
    return errorResponse(503, "docker_unavailable", "Docker is not available", { stderr: dockerCheck.stderr }, requestId);
  }

  let result;
  try {
    result = await applyTagChange(state, tag);
  } catch (e) {
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
