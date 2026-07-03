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
 * API. The `/admin/versions/releases` route calls {@link groupReleasesByUnit}
 * after fetching the raw release list.
 */

export interface ReleaseEntry {
  tag: string;
  prerelease: boolean;
  publishedAt: string;
  hasElectronBuild: boolean;
}

export interface UnitReleases {
  assistant: ReleaseEntry[];
  guardian: ReleaseEntry[];
  portals: ReleaseEntry[];
}

export interface GroupedReleases {
  releases: ReleaseEntry[];
  unitReleases: UnitReleases;
}

export type RawGitHubRelease = {
  tag_name: string;
  prerelease: boolean;
  published_at: string;
  assets: Array<{ name: string }>;
};

// Match Electron installer assets only. Anchored to ^OpenPalm- to exclude
// deploy bundles and CLI binaries. Includes .zip for the Windows installer.
const ELECTRON_ASSET_PATTERN = /^OpenPalm-.*\.(dmg|AppImage|zip|deb|rpm|pkg)$/i;

// unit-prefixed semver tag: <unit>-X.Y.Z (with optional pre-release/build).
// `portals` is the git-tag unit name; the Docker image is `portal` (singular).
const UNIT_TAG_PATTERNS: Array<{ unit: keyof UnitReleases; re: RegExp }> = [
  { unit: 'assistant', re: /^assistant-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?)$/ },
  { unit: 'guardian', re: /^guardian-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?)$/ },
  { unit: 'portals', re: /^portals-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?)$/ },
];

const PLATFORM_TAG_PATTERN = /^platform-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?)$/;
const LEGACY_V_TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?)$/;

/**
 * Group raw GitHub releases into platform (`releases`) + per-unit lists.
 *
 * Deduplicates by semver within each list so {#each r.tag} keys stay unique when
 * a platform release created both a `platform-X.Y.Z` and a legacy `vX.Y.Z` tag.
 * Preserves GitHub's `created_at` desc ordering for the picker. Non-matching
 * tags (e.g. `publish-assistant-models-*`) are skipped.
 */
export function groupReleasesByUnit(raw: RawGitHubRelease[]): GroupedReleases {
  const seenPlatform = new Set<string>();
  const seenUnit: Record<keyof UnitReleases, Set<string>> = {
    assistant: new Set(),
    guardian: new Set(),
    portals: new Set(),
  };
  const releases: ReleaseEntry[] = [];
  const unitReleases: UnitReleases = { assistant: [], guardian: [], portals: [] };

  for (const r of raw) {
    const rawTag = r.tag_name;
    const hasElectronBuild = r.assets.some((a) => ELECTRON_ASSET_PATTERN.test(a.name));
    const base = { prerelease: r.prerelease, publishedAt: r.published_at, hasElectronBuild };

    // Per-unit tags first (assistant/guardian/portals) — never carry Electron.
    const unitMatch = UNIT_TAG_PATTERNS.find((p) => p.re.test(rawTag));
    if (unitMatch) {
      // biome-ignore lint/style/noNonNullAssertion: unitMatch was found via re.test(rawTag), so rawTag.match(unitMatch.re) is non-null and every UNIT_TAG_PATTERN has one capture group, so [1] is defined.
      const tag = rawTag.match(unitMatch.re)![1];
      if (!seenUnit[unitMatch.unit].has(tag)) {
        seenUnit[unitMatch.unit].add(tag);
        unitReleases[unitMatch.unit].push({ tag, ...base });
      }
      continue;
    }

    // New-style platform-X.Y.Z — prefer these over legacy vX.Y.Z for the same semver.
    const platformMatch = rawTag.match(PLATFORM_TAG_PATTERN);
    if (platformMatch) {
      const tag = platformMatch[1];
      if (!seenPlatform.has(tag)) {
        seenPlatform.add(tag);
        releases.push({ tag, ...base });
      }
      continue;
    }

    // Legacy vX.Y.Z (strip the v) — kept for backward compat with pre-unit releases.
    const legacyMatch = rawTag.match(LEGACY_V_TAG_PATTERN);
    if (legacyMatch) {
      const tag = legacyMatch[1];
      if (!seenPlatform.has(tag)) {
        seenPlatform.add(tag);
        releases.push({ tag, ...base });
      }
    }

    // Non-matching tag — skip.
  }

  return { releases, unitReleases };
}

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

    // New-style platform-X.Y.Z — prefer these over legacy vX.Y.Z for the same semver.
    const platformMatch = r.tag_name.match(PLATFORM_TAG_PATTERN);
    if (platformMatch) {
      const tag = platformMatch[1];
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
      if (!seen.has(tag)) {
        seen.add(tag);
        releases.push({ tag, prerelease: r.prerelease, publishedAt: r.published_at, hasElectronBuild });
      }
    }
    // Per-unit tags (assistant-*, guardian-*, portals-*) and non-matching tags — skip.
  }
  return releases;
}
