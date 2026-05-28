import { json } from "@sveltejs/kit";
import { requireAdmin, getRequestId } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

export interface ReleaseEntry {
  tag: string;
  prerelease: boolean;
  publishedAt: string;
  hasUiBuild: boolean;
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
      assets: Array<{ name: string }>;
    }>;

    const releases: ReleaseEntry[] = raw.map((r) => ({
      tag: r.tag_name.replace(/^v/, ""),
      prerelease: r.prerelease,
      publishedAt: r.published_at,
      hasUiBuild: r.assets.some((a) => a.name === "ui-build.tar.gz"),
    }));

    return json({ releases });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ releases: [], error: message });
  }
};
