/**
 * POST /admin/auth/session
 *
 * Issues an `op_session` cookie after verifying the operator-supplied password
 * in the JSON body. This is the password seeded from **OP_UI_LOGIN_PASSWORD**
 * (renamed in Phase 2 of docs/technical/auth-and-proxy-refactor-plan.md from
 * the legacy `ADMIN_TOKEN`).
 *
 * Phase 2 removed the `x-admin-token` header fallback that this route used to
 * rely on; obtaining a cookie now requires the password in-body. After Phase 4
 * this endpoint and `/admin/auth/login` collapse into one — kept as an alias
 * for now so the host admin gateway (and any wizard clients) keep working
 * without a coordinated client update.
 */
import { safeTokenCompare, getRequestId, errorResponse } from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
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

  const state = getState();
  if (!state.adminToken || !safeTokenCompare(password, state.adminToken)) {
    return errorResponse(401, "unauthorized", "Invalid password", {}, requestId);
  }

  // HttpOnly prevents JS access; SameSite=Strict blocks CSRF.
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `op_session=${password}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      "x-request-id": requestId,
    },
  });
};
