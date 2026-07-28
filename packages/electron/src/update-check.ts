// Notify-only update check. Polls GitHub releases for the newest tag,
// compares to the current Electron app version, and exposes the result
// to the UI via environment variables that the SvelteKit server reads.
//
// Both modes poll the release list because standalone native-harness releases
// use `electron-X.Y.Z` tags and deliberately do not replace GitHub Latest.
// Stable mode ignores prereleases; prerelease opt-in lets an rc user see newer
// rc or stable builds. Notify-only either way — no auto-install.
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
  ELECTRON_ASSET_PATTERN,
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
  assets?: Array<{ name?: string }>;
}

/** True when a release carries at least one Electron installer asset. */
function hasInstallerAsset(release: GitHubRelease): boolean {
  return (release.assets ?? []).some((a) => ELECTRON_ASSET_PATTERN.test(a.name ?? ''));
}

const REPO_OWNER = "itlackey";
const REPO_NAME = "openpalm";
const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STALE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — stale suppression threshold
const ELECTRON_TAG_PREFIX = 'electron-';
const RELEASES_PER_PAGE = 100;

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

export function normalizeElectronReleaseVersion(tag: string): string | null {
  const trimmed = tag.trim();
  const candidate = trimmed.startsWith(ELECTRON_TAG_PREFIX)
    ? trimmed.slice(ELECTRON_TAG_PREFIX.length)
    : trimmed;
  const version = normalizeVersion(candidate);
  return isComparableSemver(version) ? version : null;
}

type ReleaseCandidate = { tag: string; url: string | null; prerelease: boolean };

function selectReleaseCandidate(
  currentVersion: string,
  releases: GitHubRelease[],
  includePrereleases: boolean,
): ReleaseCandidate | null {
  const currentIsPre = isPrerelease(currentVersion);
  let best: (ReleaseCandidate & { version: string }) | null = null;
  for (const rel of releases) {
    if (rel.draft || !hasInstallerAsset(rel)) continue;
    const tag = (rel.tag_name ?? '').trim();
    const version = normalizeElectronReleaseVersion(tag);
    if (!version) continue;
    const candidateIsPre = isPrerelease(version);
    if (candidateIsPre && (!includePrereleases || !currentIsPre)) continue;
    if (!isNewerVersion(currentVersion, version)) continue;
    if (best && compareComparableVersions(version, best.version) <= 0) continue;
    best = {
      tag,
      version,
      url: rel.html_url ?? null,
      prerelease: candidateIsPre,
    };
  }
  return best
    ? { tag: best.tag, url: best.url, prerelease: best.prerelease }
    : null;
}

export function selectStableCandidate(
  currentVersion: string,
  releases: GitHubRelease[],
): ReleaseCandidate | null {
  return selectReleaseCandidate(currentVersion, releases, false);
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
): ReleaseCandidate | null {
  return selectReleaseCandidate(currentVersion, releases, true);
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

function nextPageUrl(response: Response): string | null {
  const link = response.headers?.get?.('link');
  if (!link) return null;
  for (const entry of link.split(',')) {
    const match = entry.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (match?.[2].split(/\s+/).includes('next')) return match[1];
  }
  return null;
}

export async function checkForElectronUpdate(
  currentVersion: string,
  includePrereleases = false,
): Promise<UpdateInfo> {
  // Reuse the per-mode cached result for 6h.
  const prior = cacheSlot(includePrereleases);
  if (prior && Date.now() - prior.fetchedAt < CACHE_TTL_MS) return prior;

  let url: string | null = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=${RELEASES_PER_PAGE}`;
  try {
    const releases: GitHubRelease[] = [];
    const seenPages = new Set<string>();
    while (url) {
      if (seenPages.has(url)) throw new Error('GitHub release pagination repeated a page');
      seenPages.add(url);
      const res = await fetch(url, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        return suppressOrError(includePrereleases, currentVersion, `HTTP ${res.status}`);
      }
      const page = (await res.json()) as GitHubRelease[];
      if (!Array.isArray(page)) {
        return suppressOrError(includePrereleases, currentVersion, 'Invalid GitHub releases response');
      }
      releases.push(...page);
      const next = nextPageUrl(res);
      if (next && !next.startsWith('https://api.github.com/')) {
        throw new Error('GitHub release pagination returned an unexpected URL');
      }
      url = next;
    }

    const candidate = includePrereleases
      ? selectPrereleaseCandidate(currentVersion, releases)
      : selectStableCandidate(currentVersion, releases);
    return setCacheSlot(includePrereleases, {
      currentVersion,
      latestVersion: candidate ? normalizeElectronReleaseVersion(candidate.tag) : null,
      latestUrl: candidate?.url ?? null,
      updateAvailable: !!candidate,
      isPrerelease: candidate?.prerelease ?? false,
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
