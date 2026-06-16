// Notify-only update check. Polls GitHub releases for the newest tag,
// compares to the current Electron app version, and exposes the result
// to the UI via environment variables that the SvelteKit server reads.
//
// Two modes (#504):
//   - stable (default): poll `/releases/latest`, which GitHub excludes
//     prereleases from. A user piloting an rc therefore never sees a newer rc.
//   - prerelease opt-in: poll the full `/releases` list and surface the newest
//     release that matches the user's channel (an rc user is offered newer rc's
//     and stable; a stable user is offered only stable). Notify-only either way —
//     no auto-install.
//
// Version math routes through @openpalm/lib's canonical helpers
// (normalizeVersion / compareComparableVersions / isPrerelease / isComparableSemver)
// so the desktop app agrees with the CLI and UI on what "newer" and "prerelease"
// mean — no ad-hoc parsing.

import {
  normalizeVersion,
  compareComparableVersions,
  isPrerelease,
  isComparableSemver,
} from '@openpalm/lib';

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  latestUrl: string | null;
  updateAvailable: boolean;
  /** True when the surfaced version is a prerelease (only possible in opt-in mode). */
  isPrerelease: boolean;
  /** Set when the check failed; UI treats as "no update available". */
  error?: string;
  /** Epoch ms when this result was produced. Used by the 6h cache. */
  fetchedAt: number;
}

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
}

const REPO_OWNER = "itlackey";
const REPO_NAME = "openpalm";
const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STALE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — stale suppression threshold

// Cache is keyed by mode: toggling the prerelease opt-in must NOT reuse the
// other mode's cached result, or a user who just enabled the toggle would keep
// seeing the stable-only answer for up to 6h.
let cachedStable: UpdateInfo | null = null;
let cachedPrerelease: UpdateInfo | null = null;

/** Returns true if `latest` is strictly newer than `current`. */
export function isNewerVersion(current: string, latest: string): boolean {
  const a = normalizeVersion(current);
  const b = normalizeVersion(latest);
  if (!isComparableSemver(a) || !isComparableSemver(b)) return false;
  return compareComparableVersions(b, a) > 0;
}

/**
 * Pick the best update candidate from the full releases list, honouring the
 * user's channel: if the current version is stable, only stable releases are
 * eligible (so opt-in still doesn't down-channel a stable user onto an rc unless
 * they're already on one); if the current version is a prerelease, both newer
 * prereleases AND newer stable releases are eligible. Returns the single newest
 * eligible release, or null.
 */
export function selectPrereleaseCandidate(
  currentVersion: string,
  releases: GitHubRelease[],
): { tag: string; url: string | null; prerelease: boolean } | null {
  const currentIsPre = isPrerelease(currentVersion);
  let best: { tag: string; url: string | null; prerelease: boolean } | null = null;
  for (const rel of releases) {
    if (rel.draft) continue;
    const tag = (rel.tag_name ?? '').trim();
    const bare = normalizeVersion(tag);
    if (!isComparableSemver(bare)) continue;
    // A stable user only considers stable releases; a prerelease user considers
    // everything newer (prerelease or stable).
    if (!currentIsPre && isPrerelease(bare)) continue;
    if (!isNewerVersion(currentVersion, bare)) continue;
    if (best && compareComparableVersions(bare, normalizeVersion(best.tag)) <= 0) continue;
    best = { tag, url: rel.html_url ?? null, prerelease: isPrerelease(bare) };
  }
  return best;
}

function cacheSlot(includePrereleases: boolean): UpdateInfo | null {
  return includePrereleases ? cachedPrerelease : cachedStable;
}

function setCacheSlot(includePrereleases: boolean, info: UpdateInfo): UpdateInfo {
  if (includePrereleases) cachedPrerelease = info;
  else cachedStable = info;
  return info;
}

function suppressOrError(
  includePrereleases: boolean,
  currentVersion: string,
  reason: string,
): UpdateInfo {
  const prior = cacheSlot(includePrereleases);
  if (prior && Date.now() - prior.fetchedAt >= STALE_CACHE_TTL_MS) {
    console.debug(
      `[update-check] Cached result is older than 7 days and fresh check failed (${reason}); suppressing stale update claim`,
    );
    return setCacheSlot(includePrereleases, {
      currentVersion,
      latestVersion: null,
      latestUrl: null,
      updateAvailable: false,
      isPrerelease: false,
      error: `${reason} (stale cache suppressed)`,
      fetchedAt: Date.now(),
    });
  }
  return setCacheSlot(includePrereleases, {
    currentVersion,
    latestVersion: null,
    latestUrl: null,
    updateAvailable: false,
    isPrerelease: false,
    error: reason,
    fetchedAt: Date.now(),
  });
}

export async function checkForElectronUpdate(
  currentVersion: string,
  includePrereleases = false,
): Promise<UpdateInfo> {
  // Reuse the per-mode cached result for 6h.
  const prior = cacheSlot(includePrereleases);
  if (prior && Date.now() - prior.fetchedAt < CACHE_TTL_MS) return prior;

  const url = includePrereleases
    ? `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=30`
    : `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return suppressOrError(includePrereleases, currentVersion, `HTTP ${res.status}`);
    }

    if (includePrereleases) {
      const releases = (await res.json()) as GitHubRelease[];
      const candidate = Array.isArray(releases)
        ? selectPrereleaseCandidate(currentVersion, releases)
        : null;
      return setCacheSlot(includePrereleases, {
        currentVersion,
        latestVersion: candidate ? normalizeVersion(candidate.tag) : null,
        latestUrl: candidate?.url ?? null,
        updateAvailable: !!candidate,
        isPrerelease: candidate?.prerelease ?? false,
        fetchedAt: Date.now(),
      });
    }

    const data = (await res.json()) as GitHubRelease;
    const tag = data.tag_name ?? "";
    const latestVersion = normalizeVersion(tag);
    const updateAvailable = latestVersion ? isNewerVersion(currentVersion, latestVersion) : false;
    return setCacheSlot(includePrereleases, {
      currentVersion,
      latestVersion: latestVersion || null,
      latestUrl: data.html_url ?? null,
      updateAvailable,
      // `/releases/latest` excludes prereleases by design, so this is always stable.
      isPrerelease: false,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return suppressOrError(includePrereleases, currentVersion, errMsg);
  }
}

/** Last known update info (the most recently produced, across both modes). */
export function getCachedUpdateInfo(): UpdateInfo | null {
  if (cachedStable && cachedPrerelease) {
    return cachedPrerelease.fetchedAt >= cachedStable.fetchedAt ? cachedPrerelease : cachedStable;
  }
  return cachedPrerelease ?? cachedStable;
}

/** Test-only: clear both cache slots so cases don't bleed into each other. */
export function _resetUpdateCheckCacheForTests(): void {
  cachedStable = null;
  cachedPrerelease = null;
}
