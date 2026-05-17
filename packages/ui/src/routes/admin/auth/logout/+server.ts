import type { RequestHandler } from "./$types";
import { getRequestId } from "$lib/server/helpers.js";

const COOKIE_NAME = "op_session";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      "x-request-id": requestId
    }
  });
};
