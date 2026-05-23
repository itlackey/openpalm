/**
 * POST /admin/auth/login
 *
 * Issues the `op_session` cookie (HttpOnly, SameSite=Strict, Max-Age=86400)
 * after verifying the operator-supplied password in the request body against
 * `process.env.OP_UI_LOGIN_PASSWORD`.
 *
 * Phase 4 of docs/technical/auth-and-proxy-refactor-plan.md deleted the
 * `state.adminToken` field and the legacy `OP_UI_TOKEN`/`OP_ASSISTANT_TOKEN`
 * env vars. The cookie value IS the password — every `requireAdmin()` call
 * re-reads the env var and constant-time-compares the cookie against it.
 * No in-memory session store.
 */
import type { RequestHandler } from "./$types";
import { safeTokenCompare, getRequestId, errorResponse, getUiLoginPassword } from "$lib/server/helpers.js";

const COOKIE_NAME = "op_session";
const COOKIE_OPTS = "HttpOnly; SameSite=Strict; Path=/; Max-Age=86400";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);

  let body: Record<string, unknown>;
  try {
    body = await event.request.json() as Record<string, unknown>;
  } catch {
    return errorResponse(400, "bad_request", "Invalid JSON body", {}, requestId);
  }

  // Accept either `password` (preferred) or `token` (legacy field name) so
  // existing clients keep working while we migrate the surface to "password".
  const password =
    typeof body.password === "string" ? body.password :
    typeof body.token === "string" ? body.token : "";
  if (!password) return errorResponse(400, "bad_request", "password is required", {}, requestId);

  const configured = getUiLoginPassword();
  if (!configured) {
    return errorResponse(
      503,
      "admin_not_configured",
      "OP_UI_LOGIN_PASSWORD has not been set. Complete setup first.",
      {},
      requestId,
    );
  }
  if (!safeTokenCompare(password, configured)) {
    return errorResponse(401, "unauthorized", "Invalid password", {}, requestId);
  }

  return new Response(JSON.stringify({ ok: true, role: "admin" }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `${COOKIE_NAME}=${password}; ${COOKIE_OPTS}`,
      "x-request-id": requestId
    }
  });
};
