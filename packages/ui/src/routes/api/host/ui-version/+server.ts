import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  requireCapability,
} from "$lib/server/helpers.js";
import { seedUiBuild, resolveDataDir, createLogger, normalizeVersion } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("ui-version");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:updates', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  let body: { tag?: string };
  try { body = await event.request.json(); } catch { return errorResponse(400, "invalid_json", "Request body must be valid JSON", {}, requestId); }

  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (!tag) return errorResponse(400, "tag_required", "tag is required", {}, requestId);
  if (!/^[a-zA-Z0-9._-]+$/.test(tag)) return errorResponse(400, "invalid_tag", "Tag must be alphanumeric with . _ or - only", {}, requestId);

  const dataDir = resolveDataDir();
  // UI builds resolve from the npm registry by bare version; strip any legacy `v`.
  const repoRef = normalizeVersion(tag);

  try {
    await seedUiBuild(repoRef, dataDir, { forceRemote: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("ui-version download failed", { requestId, error: msg });
    return errorResponse(502, "download_failed", msg, { message: msg }, requestId);
  }

  // The freshly seeded data/ui does nothing until the Node child running THIS
  // process is respawned (design §6.2). The restart mechanism differs by supervisor:
  //
  // • electron — SIGUSR2 from a detached child to its Electron parent is silently
  //   dropped on Linux (different process groups) and unreliable on macOS in newer
  //   Electron/Node builds. The Electron preload already exposes window.openpalm.restartUiServer()
  //   via contextBridge → ipcMain.handle('restart-ui-server') → restartUIServer(). The
  //   client calls that IPC path after receiving pendingRestart:true here. No signal needed.
  //
  // • cli / other — SIGUSR2 to ppid remains the signal path; the CLI supervisor
  //   installs a handler that re-resolves data/ui and respawns the child.
  //
  // • none (dev preview, direct node) — no supervisor; report restarting:false so
  //   the client prompts the user to restart manually.
  const supervisor = process.env.OP_UI_SUPERVISOR ?? "";
  let restarting = false;
  let pendingRestart = false;

  if (supervisor === "electron") {
    // IPC path: client renderer must call window.openpalm.restartUiServer() after this response.
    pendingRestart = true;
    logger.info("ui-version downloaded (electron — client will restart via IPC)", { requestId, tag });
  } else if (supervisor && process.ppid && process.ppid > 1) {
    try {
      process.kill(process.ppid, "SIGUSR2");
      restarting = true;
      logger.info("ui-version restart signalled", { requestId, supervisor, ppid: process.ppid });
    } catch (e) {
      logger.warn("ui-version restart signal failed", { requestId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  logger.info("ui-version downloaded", { requestId, tag, restarting, pendingRestart });
  return jsonResponse(200, { ok: true, tag, restarting, pendingRestart }, requestId);
};
