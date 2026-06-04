import { json } from "@sveltejs/kit";
import { requireAdmin, getRequestId } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

export interface UiVersionEntry {
  /** npm version, e.g. "0.11.0-rc.2" */
  version: string;
  prerelease: boolean;
  /** ISO publish time, when available (used for sort + display). */
  publishedAt: string | null;
  /** dist-tag pointing at this version, if any ("latest" | "next"). */
  distTag: string | null;
}

const UI_PACKAGE = "@openpalm/ui";
const NPM_REGISTRY = "https://registry.npmjs.org";
const MAX_VERSIONS = 20;

/**
 * List published `@openpalm/ui` npm versions for the admin "UI build" picker.
 *
 * The UI is independently versioned and distributed via npm (not GitHub release
 * assets), so this is the authoritative source of installable UI builds — the
 * selected version is POSTed to /admin/ui-version, which seeds it from npm.
 * Returns newest-first; 404 (package not yet published) yields an empty list.
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  try {
    const res = await fetch(`${NPM_REGISTRY}/${UI_PACKAGE}`, {
      headers: { "User-Agent": "openpalm-admin/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });

    if (res.status === 404) return json({ versions: [], distTags: {} });
    if (!res.ok) return json({ versions: [], distTags: {}, error: `npm registry ${res.status}` });

    const packument = (await res.json()) as {
      versions?: Record<string, unknown>;
      time?: Record<string, string>;
      "dist-tags"?: Record<string, string>;
    };

    const distTags = packument["dist-tags"] ?? {};
    // Reverse-map version → dist-tag (only "latest"/"next" are meaningful here).
    const versionToTag = new Map<string, string>();
    for (const [tag, version] of Object.entries(distTags)) versionToTag.set(version, tag);

    const time = packument.time ?? {};
    const versions = Object.keys(packument.versions ?? {})
      .map((version): UiVersionEntry => ({
        version,
        prerelease: version.includes("-"),
        publishedAt: time[version] ?? null,
        distTag: versionToTag.get(version) ?? null,
      }))
      // Newest first by publish time; versions without a time sink to the end.
      .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
      .slice(0, MAX_VERSIONS);

    return json({ versions, distTags });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ versions: [], distTags: {}, error: message });
  }
};
