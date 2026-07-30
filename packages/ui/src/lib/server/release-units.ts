/**
 * Parse GitHub release tags into platform + per-unit release lists.
 *
 * With independently versioned units, git tags are unit-prefixed
 * (platform-X.Y.Z, assistant-X.Y.Z, guardian-X.Y.Z, portals-X.Y.Z). Docker
 * images always use the v-prefixed form, so the prefix is stripped here and the
 * UI re-adds the `v` only when talking to Docker. Legacy `vX.Y.Z` tags are kept
 * under the platform list for backward compat with pre-unit releases.
 *
 * Pure + side-effect free so it can be unit-tested without mocking the GitHub
 * API. The `/api/host/versions/releases` route calls
 * {@link selectInstallableReleases} after fetching the raw release list.
 */

// Single source of truth for "is this asset an Electron installer". The host UI
// lists desktop releases with it; the desktop app itself no longer consults it,
// because electron-updater resolves installers from the release feed (#572).
import { ELECTRON_ASSET_PATTERN, isComparableSemver } from '@openpalm/lib';

export interface ReleaseEntry {
  tag: string;
  prerelease: boolean;
  publishedAt: string;
  hasElectronBuild: boolean;
}

export type RawGitHubRelease = {
  tag_name: string;
  prerelease: boolean;
  published_at: string;
  assets: Array<{ name: string }>;
};

const PLATFORM_TAG_PATTERN = /^platform-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?)$/;
const ELECTRON_TAG_PATTERN = /^electron-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?)$/;
const LEGACY_V_TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?)$/;
const PRODUCT_TAG_PATTERN = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?)$/;

/**
 * Select only platform releases that carry installable app assets (Electron
 * installer or skeleton/deploy bundle), skipping per-unit container-image
 * releases.
 *
 * Per-unit version pickers now read from Docker Hub tags (not GitHub releases),
 * so the releases endpoint only needs app-level releases — the ones with
 * downloadable installer/bundle assets. This dramatically reduces the data the
 * UI holds and keeps the GitHub API call to its existing single request (the
 * filtering is client-side of the fetch, not a second fetch).
 *
 * Deduplicates by semver so `{#each r.tag}` keys stay unique when a platform
 * release created both a `platform-X.Y.Z` and a legacy `vX.Y.Z` tag. Preserves
 * GitHub's `created_at` desc ordering.
 */
export function selectInstallableReleases(raw: RawGitHubRelease[]): ReleaseEntry[] {
  const seen = new Set<string>();
  const releases: ReleaseEntry[] = [];
  for (const r of raw) {
    const hasElectronBuild = r.assets.some((a) => ELECTRON_ASSET_PATTERN.test(a.name));
    if (!hasElectronBuild) continue;

    // Platform and standalone native-harness releases both carry installers.
    const unitMatch = r.tag_name.match(PRODUCT_TAG_PATTERN)
      ?? r.tag_name.match(PLATFORM_TAG_PATTERN)
      ?? r.tag_name.match(ELECTRON_TAG_PATTERN);
    if (unitMatch) {
      const tag = unitMatch[1];
      if (!isComparableSemver(tag)) continue;
      if (!seen.has(tag)) {
        seen.add(tag);
        releases.push({ tag, prerelease: r.prerelease, publishedAt: r.published_at, hasElectronBuild });
      }
      continue;
    }

    // Legacy vX.Y.Z (strip the v) — kept for backward compat with pre-unit releases.
    const legacyMatch = r.tag_name.match(LEGACY_V_TAG_PATTERN);
    if (legacyMatch) {
      const tag = legacyMatch[1];
      if (!isComparableSemver(tag)) continue;
      if (!seen.has(tag)) {
        seen.add(tag);
        releases.push({ tag, prerelease: r.prerelease, publishedAt: r.published_at, hasElectronBuild });
      }
    }
    // Non-installer unit tags (assistant-*, guardian-*, portals-*) and non-matching tags — skip.
  }
  return releases;
}
