import { json } from "@sveltejs/kit";
import { requireAdmin, getRequestId } from "$lib/server/helpers.js";
import { withCache, invalidateVersionCache } from "$lib/server/version-cache.js";
import { listNpmVersions, type NpmVersionEntry } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

export type { NpmVersionEntry as UiVersionEntry } from "@openpalm/lib";

const UI_PACKAGE = "@openpalm/ui";
const CACHE_KEY = `npm:${UI_PACKAGE}`;

/**
 * List published `@openpalm/ui` npm versions for the admin "UI build" picker.
 *
 * The UI is independently versioned and distributed via npm (not GitHub release
 * assets), so this is the authoritative source of installable UI builds — the
 * selected version is POSTed to /admin/ui-version, which seeds it from npm.
 * Returns newest-first; 404 (package not yet published) yields an empty list.
 * Cached server-side so tab switches / polls do not hit the npm registry.
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  if (event.url.searchParams.get('refresh') === '1') invalidateVersionCache();

  const cached = await withCache<{ versions: NpmVersionEntry[]; distTags: Record<string, string> }>(CACHE_KEY, async () => {
    const versions = await listNpmVersions(UI_PACKAGE, { max: 20 });
    // Reverse-map version → dist-tag for the UI's distTag badge.
    const distTags: Record<string, string> = {};
    for (const v of versions) {
      if (v.distTag) distTags[v.distTag] = v.version;
    }
    return { versions, distTags };
  });

  if (cached !== undefined) {
    return json(cached);
  }

  // Fetch failed and no stale cache — return empty.
  return json({ versions: [], distTags: {}, error: "npm registry unavailable" });
};
