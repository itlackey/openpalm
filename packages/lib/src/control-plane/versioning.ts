const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:[-+].*)?$/;

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
  const clean = version.trim().replace(/^v/, '').split('+')[0];
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
