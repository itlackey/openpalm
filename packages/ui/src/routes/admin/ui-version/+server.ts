import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { seedUiBuild, readCurrentUiBuildVersion, resolveStateDir, createLogger } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("ui-version");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  let body: { tag?: string };
  try { body = await event.request.json(); } catch { return errorResponse(400, "invalid_json", "Request body must be valid JSON", {}, requestId); }

  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (!tag) return errorResponse(400, "tag_required", "tag is required", {}, requestId);
  if (!/^[a-zA-Z0-9._\-]+$/.test(tag)) return errorResponse(400, "invalid_tag", "Tag must be alphanumeric with . _ or - only", {}, requestId);

  const stateDir = resolveStateDir();
  const repoRef = tag.startsWith("v") ? tag : `v${tag}`;

  try {
    await seedUiBuild(repoRef, stateDir, { forceRemote: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("ui-version download failed", { requestId, error: msg });
    return errorResponse(502, "download_failed", msg, { message: msg }, requestId);
  }

  const version = readCurrentUiBuildVersion(stateDir) ?? tag;
  logger.info("ui-version downloaded", { requestId, version });
  return jsonResponse(200, { ok: true, version }, requestId);
};
