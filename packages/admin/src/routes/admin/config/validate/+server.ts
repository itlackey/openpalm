/**
 * GET /admin/config/validate — Run varlock environment validation.
 *
 * Checks vault/user/user.env and vault/stack/stack.env against their schemas.
 * Always returns 200; validation failures are logged to the audit trail.
 * Requires admin authentication.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  requireAuth,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { appendAudit } from "$lib/server/audit.js";
import { validateProposedState } from "$lib/server/control-plane.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAuth(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const result = await validateProposedState(state);

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
