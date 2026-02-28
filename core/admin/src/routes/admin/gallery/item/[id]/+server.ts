/**
 * GET /admin/gallery/item/[id] — Get gallery item detail by ID.
 */
import type { RequestHandler } from "./$types";
import { jsonResponse, requireAdmin, getRequestId } from "$lib/server/helpers.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const id = event.params.id;
  return jsonResponse(200, { id, risk: "low", installable: true }, requestId);
};
