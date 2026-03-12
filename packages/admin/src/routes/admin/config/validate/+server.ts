/**
 * GET /admin/config/validate — Run varlock environment validation.
 *
 * Checks CONFIG_HOME/secrets.env against the schema in DATA_HOME/secrets.env.schema.
 * Always returns 200; validation failures are logged to the audit trail.
 * Requires admin authentication.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { appendAudit } from "$lib/server/audit.js";
import { validateEnvironment } from "$lib/server/lifecycle.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const result = await validateEnvironment(state);

  // Log validation failures to the audit trail as warnings
  if (!result.ok) {
    appendAudit(
      state,
      actor,
      "config.validate",
      { errors: result.errors, warnings: result.warnings },
      false,
      requestId,
      callerType
    );
  }

  return jsonResponse(200, result, requestId);
};
