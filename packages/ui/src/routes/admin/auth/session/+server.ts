/**
 * POST /admin/auth/session
 *
 * Issues an `op_session` cookie after verifying the operator-supplied password
 * against `process.env.OP_UI_LOGIN_PASSWORD`.
 *
 * The cookie value is a random UUID session token — NOT the plaintext password.
 * Kept alongside `/admin/auth/login` as an alias so existing clients keep working.
 */
import { safeTokenCompare, getRequestId, errorResponse, getUiLoginPassword } from "$lib/server/helpers.js";
import { createSession } from "$lib/server/session-store.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);

  let body: Record<string, unknown>;
  try {
    body = await event.request.json() as Record<string, unknown>;
  } catch {
    return errorResponse(400, "bad_request", "Invalid JSON body", {}, requestId);
  }

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

  // HttpOnly prevents JS access; SameSite=Strict blocks CSRF.
  // Cookie value is an opaque session token — not the plaintext password.
  const sessionToken = createSession();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `op_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      "x-request-id": requestId,
    },
  });
};
