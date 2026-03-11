import { getRequestId, jsonResponse } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  return jsonResponse(200, { status: "ok", service: "admin" }, requestId);
};
