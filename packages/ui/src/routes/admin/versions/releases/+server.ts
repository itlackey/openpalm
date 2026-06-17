import { json } from "@sveltejs/kit";
import { requireAdmin, getRequestId } from "$lib/server/helpers.js";
import { PLATFORM_VERSION, isComparableSemver, compareComparableVersions, formatForDisplay } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

export interface ReleaseEntry {
  tag: string;
  prerelease: boolean;
  publishedAt: string;
}

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
      return json({ releases: [], error: `GitHub API ${res.status}` });
    }

    const raw = (await res.json()) as Array<{
      tag_name: string;
      prerelease: boolean;
      published_at: string;
    }>;

    // Extract semver from unit-prefixed release tags (platform-X.Y.Z → X.Y.Z)
    // and filter to platform releases only. With independently versioned units,
    // portals-*/assistant-*/guardian-* tags do not carry stack assets for the
    // version picker — only platform-* (and legacy v*) releases do.
    const platformVersion = formatForDisplay(PLATFORM_VERSION);
    const releases: ReleaseEntry[] = raw
      .map((r) => {
        const raw_tag = r.tag_name;
        // New-style unit-prefixed tag: platform-X.Y.Z
        const unitMatch = raw_tag.match(/^platform-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?)$/);
        if (unitMatch) {
          return { tag: unitMatch[1], prerelease: r.prerelease, publishedAt: r.published_at };
        }
        // Legacy style: vX.Y.Z (strip v)
        if (/^v\d/.test(raw_tag)) {
          return { tag: raw_tag.replace(/^v/, ""), prerelease: r.prerelease, publishedAt: r.published_at };
        }
        // Non-platform tags (portals-*, assistant-*, guardian-*) — skip
        return null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    return json({ releases, platformVersion });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ releases: [], error: message });
  }
};
