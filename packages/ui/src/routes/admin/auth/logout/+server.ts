import type { RequestHandler } from "./$types";
import { getRequestId } from "$lib/server/helpers.js";
import { invalidateSession } from "$lib/server/session-store.js";
import { clearSessionCookieHeader, SESSION_COOKIE_NAME } from "$lib/server/session-cookie.js";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const cookieHeader = event.request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
  if (match) invalidateSession(match[1]);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // Same name/path/attributes as the issued cookie so the browser drops it.
      "set-cookie": clearSessionCookieHeader(event.request),
      "x-request-id": requestId
    }
  });
};
