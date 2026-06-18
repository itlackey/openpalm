import { json } from "@sveltejs/kit";
import { requireAdmin, getRequestId } from "$lib/server/helpers.js";
import { withCache, invalidateVersionCache } from "$lib/server/version-cache.js";
import { selectInstallableReleases, type RawGitHubRelease } from "$lib/server/release-units.js";
import type { ReleaseEntry } from "$lib/server/release-units.js";
import type { RequestHandler } from "./$types";

const CACHE_KEY = "github:releases";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  if (event.url.searchParams.get('refresh') === '1') invalidateVersionCache();

  const cached = await withCache<ReleaseEntry[]>(CACHE_KEY, async () => {
    const res = await fetch(
      "https://api.github.com/repos/itlackey/openpalm/releases?per_page=20",
      {
        headers: { "User-Agent": "openpalm-admin/1.0", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(8_000),
      }
    );

    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}`);
    }

    const raw = (await res.json()) as RawGitHubRelease[];
    // Per-unit version pickers now read from Docker Hub tags, so the releases
    // endpoint only returns app-level releases — platform releases that carry
    // Electron installer assets. This is what populates the app update badge.
    return selectInstallableReleases(raw);
  });

  if (cached !== undefined) {
    return json({ releases: cached });
  }

  // Fetch failed and no stale cache — return empty with the error signal.
  return json({ releases: [], error: "GitHub releases unavailable" });
};
