import { getRequestId, jsonResponse } from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import type { RequestHandler } from "./$types";

/**
 * Guardian health — proxy to the actual guardian service.
 *
 * We check the container state instead of returning a hardcoded "ok".
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const state = getState();
  const guardianStatus = state.services?.["guardian"];

  if (guardianStatus === "running") {
    return jsonResponse(200, { status: "ok", service: "guardian" }, requestId);
  }
  return jsonResponse(503, { status: "unavailable", service: "guardian" }, requestId);
};
