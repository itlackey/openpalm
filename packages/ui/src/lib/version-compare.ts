/**
 * Client-safe semver comparison + update-status helpers for the Check-up tab.
 *
 * Mirrors the proven algorithm in @openpalm/lib's ui-assets.ts compareVersionTags
 * (which is server-only — it lives in a module that imports node:fs), kept here
 * as a tiny dependency-free copy so the version rows can compute up-to-date vs
 * update-available entirely in the browser. Handles a leading `v` and
 * pre-release tags per semver (1.0.0 > 1.0.0-rc.1; rc.2 > rc.1).
 */

export type UpdateStatus = 'current' | 'update' | 'unknown';

/** True when `v` parses as a comparable semver (optionally `v`-prefixed). */
export function isSemver(v: string | null | undefined): boolean {
  if (!v) return false;
  return /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(v.trim());
}

function isPrerelease(v: string): boolean {
  // Strip build metadata first — a `-` inside `+build-5` is not a pre-release.
  return v.replace(/^v/, '').split('+')[0].includes('-');
}

/** Returns 1 if a > b, -1 if a < b, 0 if equal. Strips a leading `v`. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): [number, number, number, string | null] => {
    // Strip build metadata (`+build.5`) FIRST — semver says it's ignored in
    // precedence, and leaving it in would turn the patch number into NaN
    // (`Number('3+build')`), corrupting every comparison.
    const clean = v.trim().replace(/^v/, '').split('+')[0];
    const dashIdx = clean.indexOf('-');
    const main = dashIdx === -1 ? clean : clean.slice(0, dashIdx);
    const pre = dashIdx === -1 ? null : clean.slice(dashIdx + 1);
    const parts = main.split('.').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, pre];
  };
  const comparePre = (x: string, y: string): number => {
    const xp = x.split('.');
    const yp = y.split('.');
    for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
      if (i >= xp.length) return -1;
      if (i >= yp.length) return 1;
      const xn = Number(xp[i]);
      const yn = Number(yp[i]);
      const xIsNum = !isNaN(xn);
      const yIsNum = !isNaN(yn);
      if (xIsNum && yIsNum) {
        if (xn !== yn) return xn > yn ? 1 : -1;
      } else if (xIsNum !== yIsNum) {
        return xIsNum ? -1 : 1; // numeric < alphanumeric per semver
      } else if (xp[i] !== yp[i]) {
        return xp[i]! > yp[i]! ? 1 : -1;
      }
    }
    return 0;
  };
  const [aM, am, ap, aPre] = parse(a);
  const [bM, bm, bp, bPre] = parse(b);
  if (aM !== bM) return aM > bM ? 1 : -1;
  if (am !== bm) return am > bm ? 1 : -1;
  if (ap !== bp) return ap > bp ? 1 : -1;
  if (aPre === null && bPre !== null) return 1;
  if (aPre !== null && bPre === null) return -1;
  if (aPre !== null && bPre !== null) return comparePre(aPre, bPre);
  return 0;
}

/**
 * Status of `current` against the newest `candidate` on the same channel.
 * Returns 'unknown' when either side isn't a comparable semver (e.g. a moving
 * `latest` image tag, or no release data yet) so the UI shows a neutral state
 * instead of a misleading "up to date".
 */
export function updateStatus(current: string | null | undefined, latest: string | null | undefined): UpdateStatus {
  if (!isSemver(current) || !isSemver(latest)) return 'unknown';
  return compareVersions(latest!, current!) > 0 ? 'update' : 'current';
}

/**
 * Newest version from `candidates` on `current`'s release channel: a
 * pre-release current sees all candidates; a stable current only sees stable
 * ones (so a stable user is never nudged onto an rc). Returns null when no
 * candidate qualifies. `candidates` need not be pre-sorted.
 */
export function latestForChannel(
  current: string | null | undefined,
  candidates: Array<{ version: string; prerelease: boolean }>,
): string | null {
  const wantPre = isSemver(current) ? isPrerelease(current!) : true;
  const pool = candidates.filter((c) => isSemver(c.version) && (wantPre || !c.prerelease));
  if (pool.length === 0) return null;
  return pool.reduce((best, c) => (compareVersions(c.version, best.version) > 0 ? c : best)).version;
}
