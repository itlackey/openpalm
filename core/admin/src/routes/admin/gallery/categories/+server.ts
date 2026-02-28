/**
 * GET /admin/gallery/categories — List gallery categories.
 */
import type { RequestHandler } from "./$types";
import { jsonResponse, requireAdmin, getRequestId } from "$lib/server/helpers.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  return jsonResponse(
    200,
    {
      categories: [
        { name: "plugin", count: 1 },
        { name: "skill", count: 1 },
        { name: "channel", count: 1 }
      ]
    },
    requestId
  );
};
