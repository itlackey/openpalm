import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import { safeTokenCompare, getRequestId, jsonResponse, errorResponse } from "$lib/server/helpers.js";

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

  const token = typeof body.token === "string" ? body.token : "";
  if (!token) return errorResponse(400, "bad_request", "token is required", {}, requestId);

  const state = getState();
  const isAdmin = state.adminToken && safeTokenCompare(token, state.adminToken);
  const isAssistant = state.assistantToken && safeTokenCompare(token, state.assistantToken);
  if (!isAdmin && !isAssistant) {
    return errorResponse(401, "unauthorized", "Invalid token", {}, requestId);
  }
  const role = isAdmin ? "admin" : "assistant";
  return new Response(JSON.stringify({ ok: true, role }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `${COOKIE_NAME}=${token}; ${COOKIE_OPTS}`,
      "x-request-id": requestId
    }
  });
};
