import { requireAdmin, getRequestId } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

/**
 * POST /admin/auth/session
 *
 * Issues a session cookie after verifying the x-admin-token header.
 * Used by the host admin gateway to establish cookie-based sessions.
 * No-op in container mode (cookie is not read by the container gateway).
 */
export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const token = event.request.headers.get("x-admin-token") ?? "";

  // Issue session cookie. HttpOnly prevents JS access; SameSite=Strict blocks CSRF.
  // Max-Age=86400 = 24 hours.
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `op_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
    },
  });
};
