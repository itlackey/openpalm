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

    // #492: the stack version picker drives applyTagChange, whose migrations come
    // from the RUNNING control plane (PLATFORM_VERSION). Filter out any tag newer
    // than the running platform so the host-vs-target trap is not even reachable
    // from the dropdown. The running version is labelled separately so the UI can
    // show "you are on X". Non-semver tags are kept (they can't be over-the-line).
    const platformVersion = formatForDisplay(PLATFORM_VERSION);
    const releases: ReleaseEntry[] = raw
      .map((r) => ({
        tag: r.tag_name.replace(/^v/, ""),
        prerelease: r.prerelease,
        publishedAt: r.published_at,
      }))
      .filter(
        (r) =>
          !isComparableSemver(r.tag) ||
          compareComparableVersions(r.tag, PLATFORM_VERSION) <= 0,
      );

    return json({ releases, platformVersion });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ releases: [], error: message });
  }
};
