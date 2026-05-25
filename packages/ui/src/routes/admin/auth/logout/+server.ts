import type { RequestHandler } from "./$types";
import { getRequestId } from "$lib/server/helpers.js";
import { invalidateSession } from "$lib/server/session-store.js";

const COOKIE_NAME = "op_session";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const cookieHeader = event.request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(/(?:^|;\s*)op_session=([^;]+)/);
  if (match) invalidateSession(match[1]);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      "x-request-id": requestId
    }
  });
};
