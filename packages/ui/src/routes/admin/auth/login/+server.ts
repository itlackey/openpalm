/**
 * POST /admin/auth/login
 *
 * Issues the `op_session` cookie (HttpOnly, SameSite=Strict, Max-Age=86400)
 * after verifying the operator-supplied password in the request body against
 * the configured admin secret.
 *
 * The operator-facing env var that seeds this secret is **OP_UI_LOGIN_PASSWORD**
 * (renamed from the legacy `ADMIN_TOKEN` in Phase 2 of
 * docs/technical/auth-and-proxy-refactor-plan.md). It is read from `stack.env`
 * via `state.adminToken` today; Phase 4 will collapse the field and the env
 * plumbing together. The cookie semantics are unchanged.
 *
 * Phase 2 also drops the assistant-token branch — only the admin secret is a
 * valid login credential; `state.assistantToken` no longer participates.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import { safeTokenCompare, getRequestId, errorResponse } from "$lib/server/helpers.js";

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

  const state = getState();
  if (!state.adminToken || !safeTokenCompare(password, state.adminToken)) {
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
