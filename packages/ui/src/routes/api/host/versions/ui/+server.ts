import { json } from "@sveltejs/kit";
import { requireAdmin, requireCapability, getRequestId } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

/** One installable coordinated host-assets release from GitHub. */
export interface UiVersionEntry {
  version: string;
  prerelease: boolean;
  publishedAt: string | null;
  channel: 'stable' | 'prerelease';
}

/**
 * List the two GitHub host-assets channels for the admin picker.
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:updates', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  try {
    const res = await fetch('https://api.github.com/repos/itlackey/openpalm/releases?per_page=100', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openpalm-admin/1.0' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return json({ versions: [], error: 'GitHub releases unavailable' });
    }
    const releases = await res.json() as Array<{ tag_name?: string; prerelease?: boolean; draft?: boolean; published_at?: string | null; assets?: Array<{ name?: string }> }>;
    const versions = releases.flatMap(release => {
      if (release.draft || typeof release.tag_name !== 'string') return [];
      const version = release.tag_name.replace(/^v/, '');
      if (!release.assets?.some(asset => asset.name === `openpalm-host-assets-${version}.tar.gz`)) return [];
      return [{
      version,
      prerelease: Boolean(release.prerelease),
      publishedAt: release.published_at ?? null,
      channel: release.prerelease ? 'prerelease' as const : 'stable' as const,
      }];
    }).slice(0, 20);
    return json({ versions });
  } catch {
    return json({ versions: [], error: 'GitHub releases unavailable' });
  }
};
