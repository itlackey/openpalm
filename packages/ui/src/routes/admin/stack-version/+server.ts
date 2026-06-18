import { getState } from "$lib/server/state.js";
import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import {
  applyTagChange,
  applyUnitImageTagChange,
  checkDocker,
  createLogger,
  DowngradeConfirmationRequired,
  isDeployableUnit,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("stack-version");

export const PATCH: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  let body: { tag?: string; unit?: string; confirmDowngrade?: boolean };
  try { body = await event.request.json(); } catch { return errorResponse(400, "invalid_json", "Request body must be valid JSON", {}, requestId); }

  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (!tag) return errorResponse(400, "tag_required", "tag is required", {}, requestId);
  if (!/^[a-zA-Z0-9._\-]+$/.test(tag)) return errorResponse(400, "invalid_tag", "Tag must be alphanumeric with . _ or - only", {}, requestId);
  const confirmDowngrade = body.confirmDowngrade === true;
  const unit = typeof body.unit === "string" ? body.unit.trim() : "";

  // A per-unit pin writes only that unit's OP_*_IMAGE_TAG. An empty unit keeps
  // the legacy stack-wide applyTagChange path (full platform upgrade).
  if (unit && !isDeployableUnit(unit)) {
    return errorResponse(400, "invalid_unit", `Unknown deployable unit: ${unit}`, {}, requestId);
  }

  const state = getState();

  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    logger.error("stack-version aborted: docker unavailable", { requestId });
    return errorResponse(503, "docker_unavailable", "Docker is not available", { stderr: dockerCheck.stderr }, requestId);
  }

  let result;
  try {
    result = unit
      ? await applyUnitImageTagChange(state, unit, tag, { confirmDowngrade })
      : await applyTagChange(state, tag, { confirmDowngrade });
  } catch (e) {
    if (e instanceof DowngradeConfirmationRequired) {
      // Not an error condition — the UI shows a plain warning + confirm and
      // re-submits with confirmDowngrade:true. 409 = needs confirmation.
      logger.info("stack-version downgrade requires confirmation", { requestId, unit: unit || "stack", currentVersion: e.currentVersion, targetVersion: e.targetVersion });
      return errorResponse(409, "downgrade_confirmation_required", e.message, {
        currentVersion: e.currentVersion,
        targetVersion: e.targetVersion,
      }, requestId);
    }
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("stack-version apply failed", { requestId, unit: unit || "stack", error: msg });
    return errorResponse(502, "apply_failed", msg, { message: msg }, requestId);
  }

  logger.info("stack-version applied", { requestId, unit: unit || "stack", imageTag: result.imageTag });
  return jsonResponse(200, {
    ok: true,
    imageTag: result.imageTag,
    restarted: result.restarted,
  }, requestId);
};
