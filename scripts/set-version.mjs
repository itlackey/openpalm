#!/usr/bin/env node
// Single source of truth for stamping a package.json's version.
//
// Sets `version` and keeps any internal `@openpalm/lib` *floor range* dependency
// (e.g. ">=X <N.0.0") in lockstep so the floor never goes stale (CI enforces
// this; the test suite covers it). Also stamps any `@openpalm/skeleton`
// dependency except `workspace:*` to an exact pin matching the new version so
// the CLI and skeleton are always shipped in lockstep. Exact refs are rewritten
// too because the published CLI intentionally carries an exact skeleton pin.
// Exact/non-range refs for other packages are left untouched. Used by
// bump-unit.mjs and the release workflows so there is exactly one place that
// understands how a version is written.
//
// Usage: node scripts/set-version.mjs <path/to/package.json> <version>
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PRERELEASE_IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';

export const SEMVER_RE = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?$`,
);

export function parseSemver(version) {
  const match = String(version).match(SEMVER_RE);
  return match
    ? { ma: Number(match[1]), mi: Number(match[2]), pa: Number(match[3]), pre: match[4] ?? null }
    : null;
}

export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) throw new Error(`Cannot compare invalid semver: '${a}' and '${b}'`);
  for (const key of ['ma', 'mi', 'pa']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;

  const leftParts = left.pre.split('.');
  const rightParts = right.pre.split('.');
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    if (leftParts[i] === undefined) return -1;
    if (rightParts[i] === undefined) return 1;
    const leftNumeric = /^[0-9]+$/.test(leftParts[i]);
    const rightNumeric = /^[0-9]+$/.test(rightParts[i]);
    if (leftNumeric && rightNumeric) {
      if (Number(leftParts[i]) !== Number(rightParts[i])) {
        return Number(leftParts[i]) > Number(rightParts[i]) ? 1 : -1;
      }
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (leftParts[i] !== rightParts[i]) {
      return leftParts[i] > rightParts[i] ? 1 : -1;
    }
  }
  return 0;
}

/** Stamp `version` into a package.json file (in place). Returns the new version. */
export function setVersion(file, version) {
  if (!parseSemver(version)) {
    throw new Error(`version must be semver (e.g. 1.2.3 or 1.2.3-rc1), got '${version}'`);
  }
  const pkg = JSON.parse(readFileSync(file, 'utf-8'));
  pkg.version = version;
  const major = Number.parseInt(version.split('.')[0], 10);
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
    // Keep @openpalm/lib floor range in lockstep with the package version.
    const libDep = pkg[field]?.['@openpalm/lib'];
    if (typeof libDep === 'string' && libDep.startsWith('>=')) {
      pkg[field]['@openpalm/lib'] = `>=${version} <${major + 1}.0.0`;
    }
    // Stamp @openpalm/skeleton to an exact pin matching this version so the
    // CLI and skeleton are always published and consumed in lockstep.
    const skeletonDep = pkg[field]?.['@openpalm/skeleton'];
    if (typeof skeletonDep === 'string' && skeletonDep !== 'workspace:*') {
      pkg[field]['@openpalm/skeleton'] = version;
    }
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  return version;
}

// CLI entry — only when executed directly, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , file, version] = process.argv;
  if (!file || !version) {
    console.error('Usage: set-version.mjs <package.json path> <version>');
    process.exit(1);
  }
  try {
    setVersion(file, version);
    console.log(`  ${file} → ${version}`);
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
