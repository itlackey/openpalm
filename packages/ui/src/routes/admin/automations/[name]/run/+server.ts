/**
 * POST /admin/automations/:name/run — Manually trigger an automation.
 *
 * Spawns `akm tasks run <id>` directly (no sentinel files). The task
 * must exist in ${stashDir}/tasks/<name>.md to be accepted.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAuth,
  getRequestId,
} from "$lib/server/helpers.js";
import {
  loadAutomations,
  executeAutomation,
  buildAkmEnv,
} from "@openpalm/lib";

const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+(?:\.md)?$/;

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAuth(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const rawName = event.params.name ?? "";

  // Accept both bare IDs and full filenames; normalize to bare ID.
  const taskId = rawName.endsWith(".md") ? rawName.slice(0, -3) : rawName;

  if (!SAFE_NAME_RE.test(rawName) || rawName.includes("..") || rawName.includes("/")) {
    return errorResponse(400, "invalid_input", "name must match /^[a-zA-Z0-9._-]+$/", {}, requestId);
  }

  const configured = loadAutomations(state.stashDir).some((c) => c.name === taskId);
  if (!configured) {
    return errorResponse(404, "not_found", `Automation '${taskId}' is not installed.`, {}, requestId);
  }

  const result = await executeAutomation(taskId, buildAkmEnv(state));

  return jsonResponse(202, { ok: result.ok, name: taskId, status: result.status }, requestId);
};
