import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  requireCapability,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  readSecretStripNotice,
  dismissSecretStripNotice,
  createLogger,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("secret-notice");

/**
 * #502 — one-time notice that secret-looking keys were removed from stack.env.
 * The strip itself is correct per the secret-boundary contract; this surfaces
 * it so the user knows where their value went and how to re-add it.
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:secrets', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  try {
    const notice = readSecretStripNotice(state);
    return jsonResponse(200, { ok: true, notice }, requestId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse(500, "secret_notice_failed", msg, {}, requestId);
  }
};

/** Dismiss the one-time notice. */
export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:secrets', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  try {
    dismissSecretStripNotice(state);
    logger.info("secret-strip notice dismissed", { requestId });
    return jsonResponse(200, { ok: true }, requestId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse(500, "secret_notice_dismiss_failed", msg, {}, requestId);
  }
};
