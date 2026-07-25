/**
 * POST /api/auth/login
 *
 * Issues the `op_session` cookie (HttpOnly, SameSite=Lax, Secure-on-HTTPS,
 * Max-Age=14d — see session-cookie.ts) after verifying the operator-supplied
 * password in the request body against the configured login password
 * (env var or stack secret file — see getUiLoginPassword).
 *
 * The cookie value is a stateless HMAC-signed session token — NOT the plaintext
 * password. `requireAdmin()` validates the token's signature and expiry.
 */
import type { RequestHandler } from "./$types";
import { safeTokenCompare, getRequestId, errorResponse, getUiLoginPassword } from "$lib/server/helpers.js";
import { createSession } from "$lib/server/session-store.js";
import { sessionCookieHeader } from "$lib/server/session-cookie.js";
import {
  checkLoginThrottle,
  clearLoginAttempts,
  recordLoginFailure,
} from "$lib/server/login-throttle.js";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);

  // Throttle BEFORE reading the body: an attacker should not get to spend
  // server work per attempt, and a locked-out caller gets the same answer
  // whatever they send.
  // SvelteKit always supplies getClientAddress() in production, but a missing
  // one must degrade to a shared key rather than throw — a crash here would
  // turn the throttle into a denial of the login route itself.
  let throttleKey: string;
  try {
    throttleKey = event.getClientAddress?.() || 'unknown';
  } catch {
    throttleKey = 'unknown';
  }
  const throttle = checkLoginThrottle(throttleKey);
  if (!throttle.allowed) {
    return new Response(
      JSON.stringify({
        error: "too_many_attempts",
        message: `Too many failed sign-in attempts. Try again in ${throttle.retryAfterSec}s.`,
        details: {},
        requestId,
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(throttle.retryAfterSec),
          "x-request-id": requestId,
        },
      },
    );
  }

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
    recordLoginFailure(throttleKey);
    return errorResponse(401, "unauthorized", "Invalid password", {}, requestId);
  }

  clearLoginAttempts(throttleKey);
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
