import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { seedUiBuild, resolveDataDir, createLogger } from "@openpalm/lib";
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

  const dataDir = resolveDataDir();
  const repoRef = tag.startsWith("v") ? tag : `v${tag}`;

  try {
    await seedUiBuild(repoRef, dataDir, { forceRemote: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("ui-version download failed", { requestId, error: msg });
    return errorResponse(502, "download_failed", msg, { message: msg }, requestId);
  }

  // The freshly seeded data/ui does nothing until the Node child running THIS
  // process is respawned (design §6.2) — the old @openpalm/lib (+ migrations)
  // is held in memory. Signal the supervisor (CLI `openpalm ui serve` or the
  // Electron harness) to kill + respawn us against the new build. The supervisor
  // installs a SIGHUP handler that re-resolves data/ui and respawns; OP_UI_SUPERVISOR
  // is set by the supervisor when it spawned us. Best-effort: if there is no
  // supervisor (dev `vite preview`, direct `node index.js`), report restarting:false
  // so the client tells the user to restart manually.
  const supervisor = process.env.OP_UI_SUPERVISOR ?? "";
  let restarting = false;
  if (supervisor && process.ppid && process.ppid > 1) {
    try {
      process.kill(process.ppid, "SIGHUP");
      restarting = true;
      logger.info("ui-version restart signalled", { requestId, supervisor, ppid: process.ppid });
    } catch (e) {
      logger.warn("ui-version restart signal failed", { requestId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  logger.info("ui-version downloaded", { requestId, tag, restarting });
  return jsonResponse(200, { ok: true, tag, restarting }, requestId);
};
