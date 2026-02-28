/**
 * GET /admin/gallery/search — Search gallery extensions.
 */
import type { RequestHandler } from "./$types";
import { jsonResponse, requireAdmin, getRequestId } from "$lib/server/helpers.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const url = new URL(event.request.url);
  const q = url.searchParams.get("q") ?? "";

  const allItems = [
    { id: "plugin-policy-telemetry", category: "plugin", title: "Policy Telemetry" },
    { id: "skill-ralph-wiggum", category: "skill", title: "Ralph Loop" }
  ];

  const items = allItems.filter(
    (item) =>
      item.id.includes(q) || item.title.toLowerCase().includes(q.toLowerCase())
  );

  return jsonResponse(200, { items }, requestId);
};
