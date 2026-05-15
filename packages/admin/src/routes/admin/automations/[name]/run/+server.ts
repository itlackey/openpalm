/**
 * POST /admin/automations/:name/run — Manually trigger an automation.
 *
 * The scheduler now runs as a co-process inside the assistant container and
 * has no HTTP API. Triggers are filesystem-based: we drop a sentinel file
 * under `${OP_HOME}/data/scheduler/triggers/<name>.run`. The scheduler
 * watches that directory and fires the matching automation, deleting the
 * sentinel as soon as the run starts.
 */
import type { RequestHandler } from "./$types";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAuth,
  getRequestId,
  getActor,
  getCallerType,
} from "$lib/server/helpers.js";
import { appendAudit, loadAutomations } from "@openpalm/lib";

// Allow the same character set used by automation fileNames in the scheduler
// (alphanumerics plus `._-`) followed by the `.yml` suffix.
const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+\.yml$/;

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAuth(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const rawName = event.params.name ?? "";

  // Accept both bare base names and full filenames; normalize to .yml.
  const fileName = rawName.endsWith(".yml") ? rawName : `${rawName}.yml`;

  if (!SAFE_NAME_RE.test(fileName) || fileName.includes("..") || fileName.includes("/")) {
    appendAudit(
      state,
      actor,
      "automations.run",
      { fileName: rawName, error: "invalid_name" },
      false,
      requestId,
      callerType,
    );
    return errorResponse(400, "invalid_input", "name must match /^[a-zA-Z0-9._-]+\\.yml$/", {}, requestId);
  }

  const configured = loadAutomations(state.configDir).some((c) => c.fileName === fileName);
  if (!configured) {
    appendAudit(
      state,
      actor,
      "automations.run",
      { fileName, error: "not_found" },
      false,
      requestId,
      callerType,
    );
    return errorResponse(404, "not_found", `Automation '${fileName}' is not installed.`, {}, requestId);
  }

  const triggersDir = join(state.stateDir, "scheduler", "triggers");
  try {
    if (!existsSync(triggersDir)) mkdirSync(triggersDir, { recursive: true });
    writeFileSync(join(triggersDir, `${fileName}.run`), "");
  } catch (err) {
    appendAudit(
      state,
      actor,
      "automations.run",
      { fileName, error: String(err) },
      false,
      requestId,
      callerType,
    );
    return errorResponse(500, "internal_error", `Failed to write trigger sentinel: ${String(err)}`, {}, requestId);
  }

  appendAudit(state, actor, "automations.run", { fileName }, true, requestId, callerType);
  return jsonResponse(202, { ok: true, fileName, queued: true }, requestId);
};
