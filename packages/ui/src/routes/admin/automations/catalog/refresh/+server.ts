/**
 * POST /admin/automations/catalog/refresh — Refresh the runtime catalog from GitHub.
 */
import { existsSync, readdirSync } from "node:fs";
import type { RequestHandler } from "@sveltejs/kit";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import {
  appendAudit,
  refreshRegistryCatalog
} from "@openpalm/lib";


export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  try {
    const result = refreshRegistryCatalog();
    appendAudit(
      state,
      actor,
      "automations.catalog.refresh",
      { root: result.root, addonCount: result.addonCount, automationCount: result.automationCount },
      true,
      requestId,
      callerType,
    );
    const tasksDir = `${state.stashDir}/tasks`;
    const taskFiles = existsSync(tasksDir)
      ? readdirSync(tasksDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(".md", ""))
      : [];

    return jsonResponse(
      200,
      {
        ok: true,
        root: result.root,
        addonCount: result.addonCount,
        automationCount: result.automationCount,
        tasks: taskFiles,
        cronSyncRequired: taskFiles.length > 0,
      },
      requestId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendAudit(state, actor, "automations.catalog.refresh", { error: message }, false, requestId, callerType);
    return errorResponse(500, "registry_sync_error", message, {}, requestId);
  }
};
