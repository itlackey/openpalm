/**
 * GET  /admin/automations — List all merged automation jobs + scheduler status.
 * POST /admin/automations — Create a new user-defined automation job.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType,
  parseJsonBody
} from "$lib/server/helpers.js";
import {
  appendAudit,
  persistArtifacts,
  stageArtifacts
} from "$lib/server/control-plane.js";
import {
  validateAutomationJob,
  addUserJob,
  getNextRunTimes
} from "$lib/server/automations.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();

  appendAudit(
    state,
    getActor(event),
    "automations.list",
    {},
    true,
    requestId,
    getCallerType(event)
  );

  return jsonResponse(200, {
    jobs: state.automations.jobs,
    schedulerActive: state.automations.schedulerActive,
    nextRuns: getNextRunTimes(state.automations.jobs),
  }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const body = await parseJsonBody(event.request);

  // Validate the job
  const result = validateAutomationJob(body);
  if (!result.ok) {
    appendAudit(state, actor, "automations.create", { error: result.error }, false, requestId, callerType);
    return errorResponse(400, "invalid_input", result.error, {}, requestId);
  }

  // Add to CONFIG_HOME/automations.json
  const addErr = addUserJob(state.configDir, result.job);
  if (addErr) {
    appendAudit(state, actor, "automations.create", { error: addErr }, false, requestId, callerType);
    return errorResponse(400, "invalid_input", addErr, {}, requestId);
  }

  // Re-stage artifacts so scheduler picks up the change
  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);

  appendAudit(
    state,
    actor,
    "automations.create",
    { jobId: result.job.id },
    true,
    requestId,
    callerType
  );

  return jsonResponse(201, { ok: true, job: { ...result.job, source: "user" } }, requestId);
};
