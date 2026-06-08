/**
 * POST /admin/auth/login
 *
 * Issues the `op_session` cookie (HttpOnly, SameSite=Lax, Secure-on-HTTPS,
 * Max-Age=7d — see session-cookie.ts) after verifying the operator-supplied
 * password in the request body against
 * `process.env.OP_UI_LOGIN_PASSWORD`.
 *
 * The cookie value is a random UUID session token — NOT the plaintext password.
 * `requireAdmin()` validates the token against the in-memory session store.
 */
import type { RequestHandler } from "./$types";
import { safeTokenCompare, getRequestId, errorResponse, getUiLoginPassword } from "$lib/server/helpers.js";
import { createSession } from "$lib/server/session-store.js";
import { sessionCookieHeader } from "$lib/server/session-cookie.js";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);

  let body: Record<string, unknown>;
  try {
    body = await event.request.json() as Record<string, unknown>;
  } catch {
    return errorResponse(400, "bad_request", "Invalid JSON body", {}, requestId);
  }

  const password = typeof body.password === "string" ? body.password : "";
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

  const sessionToken = createSession();
  return new Response(JSON.stringify({ ok: true, role: "admin" }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": sessionCookieHeader(sessionToken, event.request),
      "x-request-id": requestId
    }
  });
};
