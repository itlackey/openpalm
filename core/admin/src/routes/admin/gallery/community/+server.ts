/**
 * GET /admin/gallery/community — List community extensions.
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
      items: [
        { id: "community-channel-chat", category: "channel", title: "Community Chat Adapter" }
      ]
    },
    requestId
  );
};
