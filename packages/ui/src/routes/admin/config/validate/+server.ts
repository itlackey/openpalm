/**
 * GET /admin/config/validate — Run environment validation.
 *
 * Checks config/stack/stack.env and knowledge/vaults/secrets for required runtime
 * configuration and non-empty required tokens. No varlock — the in-house
 * validator in @openpalm/lib does the key-presence check.
 * Always returns 200; validation failures are logged to the audit trail.
 * Requires admin authentication.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  requireAdmin,
  getRequestId,
} from "$lib/server/helpers.js";
import { validateProposedState, createLogger } from "@openpalm/lib";

const logger = createLogger("admin.config.validate");

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const result = await validateProposedState(state);

  // Log validation failures via application logger; OpenCode session logs +
  // operator-side stderr (per D6a) are the audit trail.
  if (!result.ok) {
    logger.warn("config validation failed", {
      requestId,
      errors: result.errors,
      warnings: result.warnings,
    });
  }

  return jsonResponse(200, result, requestId);
};
