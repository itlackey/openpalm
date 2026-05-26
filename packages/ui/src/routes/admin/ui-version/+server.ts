import { json } from "@sveltejs/kit";
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
  try { body = await event.request.json(); } catch { return json({ error: "Invalid JSON" }, { status: 400 }); }

  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (!tag) return json({ error: "tag is required" }, { status: 400 });
  if (!/^[a-zA-Z0-9._\-]+$/.test(tag)) return json({ error: "invalid tag format" }, { status: 400 });

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
