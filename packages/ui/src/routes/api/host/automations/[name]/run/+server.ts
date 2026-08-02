/**
 * POST /api/host/automations/:name/run — Manually trigger an automation.
 *
 * Executes `akm task run <id>` inside the Assistant container. The task must
 * exist in ${stashDir}/tasks/<name>.yml to be accepted.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  requireCapability,
  getRequestId,
} from "$lib/server/helpers.js";
import {
  loadAutomations,
  executeAutomation,
} from "@openpalm/lib";

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UNSUPPORTED_SUFFIX_RE = /\.yaml$/i;
const AMBIGUOUS_TASK_ID_SUFFIX_RE = /\.ya?ml$/i;

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:stack:write', requestId);
  if (capabilityError) return capabilityError;
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const rawName = event.params.name ?? "";

  // Accept both bare IDs and full filenames; normalize to bare ID.
  const taskId = rawName.replace(/\.yml$/, '');

  if (
    !SAFE_NAME_RE.test(rawName) ||
    UNSUPPORTED_SUFFIX_RE.test(rawName) ||
    AMBIGUOUS_TASK_ID_SUFFIX_RE.test(taskId) ||
    rawName.includes("/")
  ) {
    return errorResponse(400, "invalid_input", "name must match /^[a-zA-Z0-9._-]+$/", {}, requestId);
  }

  const configured = loadAutomations(state.stashDir).some((c) => c.name === taskId);
  if (!configured) {
    return errorResponse(404, "not_found", `Automation '${taskId}' is not installed.`, {}, requestId);
  }

  const result = await executeAutomation(state, taskId);

  return jsonResponse(202, { ok: result.ok, name: taskId, status: result.status, error: result.error ?? null }, requestId);
};
