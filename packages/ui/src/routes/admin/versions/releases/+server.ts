import { json } from "@sveltejs/kit";
import { requireAdmin, getRequestId } from "$lib/server/helpers.js";
import { selectInstallableReleases, type RawGitHubRelease } from "$lib/server/release-units.js";
import type { RequestHandler } from "./$types";

/**
 * GET /admin/versions/releases — list installable platform releases from GitHub.
 *
 * Powers the desktop App-update badge: only platform releases that carry an
 * Electron installer asset. Best-effort — a GitHub outage yields an empty list
 * with an error signal rather than failing the page. (No server-side cache: the
 * admin UI no longer polls this, so a direct fetch per visit is fine.)
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  try {
    const res = await fetch(
      "https://api.github.com/repos/itlackey/openpalm/releases?per_page=20",
      {
        headers: { "User-Agent": "openpalm-admin/1.0", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(8_000),
      }
    );
    if (!res.ok) {
      return json({ releases: [], error: "GitHub releases unavailable" });
    }
    const raw = (await res.json()) as RawGitHubRelease[];
    // Only app-level platform releases that carry Electron installer assets —
    // this is what populates the desktop app update badge.
    return json({ releases: selectInstallableReleases(raw) });
  } catch {
    return json({ releases: [], error: "GitHub releases unavailable" });
  }
};
