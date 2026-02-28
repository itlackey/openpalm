/**
 * POST /admin/automations/:id/run — Manually trigger a job immediately.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { appendAudit } from "$lib/server/control-plane.js";
import { executeJob } from "$lib/server/automations.js";

export const POST: RequestHandler = async (event) => {
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

  const run = await executeJob(state, job, "manual");

  appendAudit(
    state,
    actor,
    "automations.run",
    { jobId: id, trigger: "manual", ok: run.ok, durationMs: run.durationMs },
    run.ok,
    requestId,
    callerType
  );

  return jsonResponse(200, { ok: true, run }, requestId);
};
