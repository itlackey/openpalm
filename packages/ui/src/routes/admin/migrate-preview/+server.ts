import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  ensureReleaseMigrated,
  formatForDisplay,
  PLATFORM_VERSION,
  createLogger,
  MigrationError,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("migrate-preview");

/**
 * Preview (#497): show the copy-only release migrations an upgrade to <tag>
 * WOULD run, before the user applies it. Routes through
 * `ensureReleaseMigrated({ dryRun: true })`, which logs `[dry-run]` lines and
 * writes nothing. The same preview the CLI's `migrate --dry-run --to` surfaces.
 */
export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  let body: { tag?: string };
  try { body = await event.request.json(); } catch { body = {}; }
  const requested = typeof body.tag === "string" ? body.tag.trim() : "";
  if (requested && !/^[a-zA-Z0-9._\-]+$/.test(requested)) {
    return errorResponse(400, "invalid_tag", "Tag must be alphanumeric with . _ or - only", {}, requestId);
  }

  const state = getState();

  // With Docker Hub / npm "latest" lookups removed, the default migrate target
  // is the running control-plane version (PLATFORM_VERSION) — the version whose
  // release migrations the running build carries. An explicit tag overrides it.
  let targetVersion = requested;
  if (!targetVersion || requested.toLowerCase() === "latest") {
    targetVersion = PLATFORM_VERSION;
  }

  const lines: string[] = [];
  try {
    const report = ensureReleaseMigrated({
      homeDir: state.homeDir,
      targetVersion,
      dryRun: true,
      log: (m) => lines.push(m),
    });
    logger.info("migrate preview computed", { requestId, targetVersion, applied: report.applied.length });
    return jsonResponse(200, {
      ok: true,
      targetVersion: formatForDisplay(targetVersion),
      applied: report.applied,
      lines,
      notes: report.notes,
    }, requestId);
  } catch (e) {
    if (e instanceof MigrationError) {
      return errorResponse(500, "preview_failed", e.message, { guidance: e.guidance }, requestId);
    }
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse(500, "preview_failed", msg, {}, requestId);
  }
};
