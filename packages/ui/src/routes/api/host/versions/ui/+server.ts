import { json } from "@sveltejs/kit";
import { requireAdmin, requireCapability, getRequestId } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

/** One installable `@openpalm/ui` build from the npm registry. */
export interface UiVersionEntry {
  version: string;
  prerelease: boolean;
  publishedAt: string | null;
  distTag: string | null;
}

const UI_PACKAGE = "@openpalm/ui";

type Packument = {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, unknown>;
  time?: Record<string, string>;
};

/**
 * List published `@openpalm/ui` npm versions for the admin "UI build" picker.
 *
 * The UI is independently versioned and distributed via npm, so this is the
 * authoritative source of installable UI builds — the selected version is POSTed
 * to /api/host/ui-version, which seeds it from npm. Best-effort: a 404 (package not
 * yet published) or registry outage yields an empty list. Newest-first. (No
 * server-side cache — the admin UI no longer polls this.)
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:updates', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(UI_PACKAGE)}`, {
      headers: { Accept: "application/json", "User-Agent": "openpalm-admin/1.0" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return json({ versions: [], distTags: {}, error: "npm registry unavailable" });
    }
    const pack = (await res.json()) as Packument;

    const distTagByVersion = new Map<string, string>();
    const distTags: Record<string, string> = {};
    for (const [tag, version] of Object.entries(pack["dist-tags"] ?? {})) {
      distTags[tag] = version;
      // Prefer "latest" if a version carries multiple tags.
      if (!distTagByVersion.has(version) || tag === "latest") distTagByVersion.set(version, tag);
    }

    const allVersions = Object.keys(pack.versions ?? {});
    const time = pack.time ?? {};
    const versions: UiVersionEntry[] = allVersions
      .map((version) => ({
        version,
        prerelease: version.includes("-"),
        publishedAt: time[version] ?? null,
        distTag: distTagByVersion.get(version) ?? null,
      }))
      // Newest-first by publish time (fall back to lexical when time is absent).
      .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
      .slice(0, 20);

    return json({ versions, distTags });
  } catch {
    return json({ versions: [], distTags: {}, error: "npm registry unavailable" });
  }
};
