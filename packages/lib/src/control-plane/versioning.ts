import libPkg from "../../package.json" with { type: "json" };

const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:[-+].*)?$/;

/**
 * The canonical control-plane / platform version.
 *
 * This is the ONE source of truth for "which @openpalm/lib (and therefore which
 * RELEASE_MIGRATIONS + lifecycle) is running." It travels with the data/ui
 * build (the published @openpalm/ui inlines this lib), so it self-updates in
 * place — it is NOT the Electron harness version (see
 * packages/electron/src/harness-contract.ts: HARNESS_CONTRACT_VERSION).
 *
 * Stored BARE (npm form, no `v`) — the canonical spelling everywhere. Docker
 * image tags, git tags, `.skeleton-version`, `OP_RELEASE_VERSION`, and
 * `OP_*_VERSION` are all bare as of 0.12.41 (the `v` prefix was retired); reads
 * still tolerate a legacy leading `v` via `normalizeVersion`. A `v`-prefixed
 * PLATFORM_VERSION was the source of a false-mismatch bug class ("v0.12.37"
 * stamp vs "0.12.37" tag).
 */
export const PLATFORM_VERSION: string = normalizeVersion(libPkg.version);

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
};

export function isComparableSemver(version: string | null | undefined): boolean {
  return !!version && SEMVER_RE.test(version.trim());
}

function parseComparableVersion(version: string): ParsedVersion {
  const clean = normalizeVersion(version).split('+')[0];
  const dashIdx = clean.indexOf('-');
  const main = dashIdx === -1 ? clean : clean.slice(0, dashIdx);
  const prerelease = dashIdx === -1 ? null : clean.slice(dashIdx + 1);
  const [major = 0, minor = 0, patch = 0] = main.split('.').map(Number);
  return { major, minor, patch, prerelease };
}

function comparePrerelease(a: string, b: string): number {
  const aParts = a.split('.');
  const bParts = b.split('.');
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    if (i >= aParts.length) return -1;
    if (i >= bParts.length) return 1;
    const aNum = Number(aParts[i]);
    const bNum = Number(bParts[i]);
    const aIsNum = !Number.isNaN(aNum);
    const bIsNum = !Number.isNaN(bNum);
    if (aIsNum && bIsNum) {
      if (aNum !== bNum) return aNum > bNum ? 1 : -1;
      continue;
    }
    if (aIsNum !== bIsNum) return aIsNum ? -1 : 1;
    if (aParts[i] !== bParts[i]) return aParts[i]! > bParts[i]! ? 1 : -1;
  }
  return 0;
}

export function compareComparableVersions(a: string, b: string): number {
  const aParsed = parseComparableVersion(a);
  const bParsed = parseComparableVersion(b);
  if (aParsed.major !== bParsed.major) return aParsed.major > bParsed.major ? 1 : -1;
  if (aParsed.minor !== bParsed.minor) return aParsed.minor > bParsed.minor ? 1 : -1;
  if (aParsed.patch !== bParsed.patch) return aParsed.patch > bParsed.patch ? 1 : -1;
  if (aParsed.prerelease === null && bParsed.prerelease !== null) return 1;
  if (aParsed.prerelease !== null && bParsed.prerelease === null) return -1;
  if (aParsed.prerelease !== null && bParsed.prerelease !== null) {
    return comparePrerelease(aParsed.prerelease, bParsed.prerelease);
  }
  return 0;
}

export function majorVersionOf(version: string | null | undefined): number | null {
  if (!isComparableSemver(version)) return null;
  return parseComparableVersion(version!).major;
}

export function isSameMajorVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const aMajor = majorVersionOf(a);
  const bMajor = majorVersionOf(b);
  return aMajor !== null && bMajor !== null && aMajor === bMajor;
}

// ── Canonical normalization across the version vocabularies ───────────────────
// Versions are bare everywhere (`0.12.0`) as of 0.12.41; npm dist-tags route
// stable → `latest` / prerelease → `next`. `normalizeVersion` is the ONE place
// that strips a legacy leading `v` (still present on pre-cutover Docker/git
// tags); route ad-hoc `replace(/^v/, '')` and `version.includes('-')` checks
// through these helpers instead of re-deriving inline.

/**
 * Canonical bare form: strip a single legacy leading `v` and trim. `v0.12.0` →
 * `0.12.0`. Pass-through for an already-bare version. Empty/whitespace → ''.
 * This is the form written to stack.env (`OP_*_VERSION`), used as the Docker
 * image tag, and stamped into `.skeleton-version`.
 */
export function normalizeVersion(version: string | null | undefined): string {
  return (version ?? '').trim().replace(/^v/, '');
}

/**
 * True when `version` carries a semver pre-release segment (`0.12.0-rc.1`).
 * Build metadata (`+build.5`) is NOT a pre-release. Non-semver → false.
 */
export function isPrerelease(version: string | null | undefined): boolean {
  if (!isComparableSemver(version)) return false;
  return parseComparableVersion(version!).prerelease !== null;
}

/**
 * The npm dist-tag channel a release stream tracks: prereleases ride `next`,
 * stable rides `latest`. Canonical home for the prerelease→channel mapping.
 */
export function distTagForVersion(version: string | null | undefined): 'latest' | 'next' {
  return isPrerelease(version) ? 'next' : 'latest';
}

/**
 * User-facing presentation form: drop the leading `v` so the UI shows one
 * canonical spelling regardless of whether the value arrived as a Docker tag or
 * an npm version. Non-semver values are returned trimmed but otherwise untouched
 * (e.g. a moving `latest`/`dev` tag).
 */
export function formatForDisplay(version: string | null | undefined): string {
  return normalizeVersion(version);
}
