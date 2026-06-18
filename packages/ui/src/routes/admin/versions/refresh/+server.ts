import { json } from "@sveltejs/kit";
import { requireAdmin, getRequestId } from "$lib/server/helpers.js";
import { invalidateVersionCache } from "$lib/server/version-cache.js";
import type { RequestHandler } from "./$types";

/**
 * POST /admin/versions/refresh — invalidate all server-side version caches.
 *
 * Called by the admin UI's "Check for updates" button before re-fetching
 * versions + releases + UI versions. The subsequent GETs see a cold cache and
 * hit the upstreams (Docker Hub / npm / GitHub) once, then cache the fresh
 * results for the TTL window.
 */
export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  invalidateVersionCache();
  return json({ ok: true });
};
