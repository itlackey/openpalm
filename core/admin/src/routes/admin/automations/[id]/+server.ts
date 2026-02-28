/**
 * GET    /admin/automations/:id — Get a single automation job + last run.
 * PATCH  /admin/automations/:id — Update a job (user: full edit; system: override via CONFIG).
 * DELETE /admin/automations/:id — Delete a user job (system jobs cannot be deleted).
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
  validateCronExpression
} from "$lib/server/cron-parser.js";
import {
  updateUserJob,
  removeUserJob,
  overrideSystemJob,
  getNextRunTime,
  type AutomationJob
} from "$lib/server/automations.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const id = event.params.id;
  const job = state.automations.jobs.find((j) => j.id === id);

  if (!job) {
    return errorResponse(404, "not_found", `Automation "${id}" not found`, {}, requestId);
  }

  const lastRun = [...state.automations.history]
    .reverse()
    .find((h) => h.jobId === id) ?? null;

  appendAudit(
    state,
    getActor(event),
    "automations.get",
    { jobId: id },
    true,
    requestId,
    getCallerType(event)
  );

  return jsonResponse(200, {
    job,
    lastRun,
    nextRun: getNextRunTime(job),
  }, requestId);
};

export const PATCH: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const id = event.params.id;
  const body = await parseJsonBody(event.request);

  const job = state.automations.jobs.find((j) => j.id === id);
  if (!job) {
    return errorResponse(404, "not_found", `Automation "${id}" not found`, {}, requestId);
  }

  // Validate partial updates
  if (body.schedule !== undefined) {
    const cronErr = validateCronExpression(body.schedule as string);
    if (cronErr) {
      appendAudit(state, actor, "automations.update", { jobId: id, error: cronErr }, false, requestId, callerType);
      return errorResponse(400, "invalid_input", `Invalid cron expression: ${cronErr}`, {}, requestId);
    }
  }
  if (body.name !== undefined && (typeof body.name !== "string" || !(body.name as string).trim())) {
    return errorResponse(400, "invalid_input", "Job name must be a non-empty string", {}, requestId);
  }
  if (body.prompt !== undefined && (typeof body.prompt !== "string" || !(body.prompt as string).trim())) {
    return errorResponse(400, "invalid_input", "Job prompt must be a non-empty string", {}, requestId);
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return errorResponse(400, "invalid_input", "enabled must be a boolean", {}, requestId);
  }
  if (body.timeoutMs !== undefined && (typeof body.timeoutMs !== "number" || (body.timeoutMs as number) < 1000)) {
    return errorResponse(400, "invalid_input", "timeoutMs must be a number >= 1000", {}, requestId);
  }

  const updates: Partial<AutomationJob> = {};
  if (body.name !== undefined) updates.name = (body.name as string).trim();
  if (body.schedule !== undefined) updates.schedule = body.schedule as string;
  if (body.prompt !== undefined) updates.prompt = body.prompt as string;
  if (body.enabled !== undefined) updates.enabled = body.enabled as boolean;
  if (body.description !== undefined) updates.description = body.description as string;
  if (body.timeoutMs !== undefined) updates.timeoutMs = body.timeoutMs as number;

  let updateErr: string | null;
  if (job.source === "system") {
    // System jobs are overridden via CONFIG_HOME (merge logic applies the override)
    updateErr = overrideSystemJob(state.configDir, state.dataDir, id, updates);
  } else {
    updateErr = updateUserJob(state.configDir, id, updates);
  }

  if (updateErr) {
    appendAudit(state, actor, "automations.update", { jobId: id, error: updateErr }, false, requestId, callerType);
    return errorResponse(400, "invalid_input", updateErr, {}, requestId);
  }

  // Re-stage artifacts
  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);

  const updatedJob = state.automations.jobs.find((j) => j.id === id);

  appendAudit(
    state,
    actor,
    "automations.update",
    { jobId: id, updates: Object.keys(updates) },
    true,
    requestId,
    callerType
  );

  return jsonResponse(200, { ok: true, job: updatedJob }, requestId);
};

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const id = event.params.id;

  const job = state.automations.jobs.find((j) => j.id === id);
  if (!job) {
    return errorResponse(404, "not_found", `Automation "${id}" not found`, {}, requestId);
  }

  if (job.source === "system") {
    appendAudit(state, actor, "automations.delete", { jobId: id, error: "system jobs cannot be deleted" }, false, requestId, callerType);
    return errorResponse(400, "invalid_input", "System-managed jobs cannot be deleted. Use PATCH to disable instead.", {}, requestId);
  }

  const removeErr = removeUserJob(state.configDir, id);
  if (removeErr) {
    appendAudit(state, actor, "automations.delete", { jobId: id, error: removeErr }, false, requestId, callerType);
    return errorResponse(400, "invalid_input", removeErr, {}, requestId);
  }

  // Re-stage artifacts
  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);

  appendAudit(
    state,
    actor,
    "automations.delete",
    { jobId: id },
    true,
    requestId,
    callerType
  );

  return jsonResponse(200, { ok: true, deleted: id }, requestId);
};
