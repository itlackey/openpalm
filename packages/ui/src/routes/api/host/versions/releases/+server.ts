import { json } from "@sveltejs/kit";
import { requireAdmin, requireCapability, getRequestId } from "$lib/server/helpers.js";
import { selectInstallableReleases, type RawGitHubRelease } from "$lib/server/release-units.js";
import type { RequestHandler } from "./$types";

function nextPageUrl(response: Response): string | null {
  const link = response.headers.get('link');
  if (!link) return null;
  return link.split(',')
    .map((entry: string) => entry.trim().match(/^<([^>]+)>;\s*rel="next"$/)?.[1])
    .find((value): value is string => typeof value === 'string') ?? null;
}

/**
 * GET /api/host/versions/releases — list installable desktop releases from GitHub.
 *
 * Powers the desktop App-update badge: only releases that carry an Electron
 * installer asset. Best-effort — a GitHub outage yields an empty list
 * with an error signal rather than failing the page. (No server-side cache: the
 * admin UI no longer polls this, so a direct fetch per visit is fine.)
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:updates', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  try {
    const raw: RawGitHubRelease[] = [];
    const seenPages = new Set<string>();
    let url: string | null = "https://api.github.com/repos/itlackey/openpalm/releases?per_page=100";
    while (url) {
      if (seenPages.has(url)) return json({ releases: [], error: "GitHub releases unavailable" });
      seenPages.add(url);
      const res: Response = await fetch(url, {
        headers: { "User-Agent": "openpalm-admin/1.0", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return json({ releases: [], error: "GitHub releases unavailable" });
      const page = (await res.json()) as RawGitHubRelease[];
      if (!Array.isArray(page)) return json({ releases: [], error: "GitHub releases unavailable" });
      raw.push(...page);
      const next: string | null = nextPageUrl(res);
      if (next && !next.startsWith('https://api.github.com/')) {
        return json({ releases: [], error: "GitHub releases unavailable" });
      }
      url = next;
    }
    // Only app-level releases that carry Electron installer assets —
    // this is what populates the desktop app update badge.
    return json({ releases: selectInstallableReleases(raw) });
  } catch {
    return json({ releases: [], error: "GitHub releases unavailable" });
  }
};
