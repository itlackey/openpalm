#!/usr/bin/env node
// Single source of truth for stamping a package.json's version.
//
// Sets `version` and keeps any internal `@openpalm/lib` *floor range* dependency
// (e.g. ">=X <N.0.0") in lockstep so the floor never goes stale (CI enforces
// this; the test suite covers it). `workspace:*` and exact/non-range refs are
// left untouched. Used by scripts/bump-platform.sh and the release workflows so
// there is exactly one place that understands how a version is written.
//
// Usage: node scripts/set-version.mjs <path/to/package.json> <version>
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SEMVER_RE =
  /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** Stamp `version` into a package.json file (in place). Returns the new version. */
export function setVersion(file, version) {
  if (!SEMVER_RE.test(version)) {
    throw new Error(`version must be semver (e.g. 1.2.3 or 1.2.3-rc1), got '${version}'`);
  }
  const pkg = JSON.parse(readFileSync(file, 'utf-8'));
  pkg.version = version;
  const major = Number.parseInt(version.split('.')[0], 10);
  for (const field of ['dependencies', 'peerDependencies']) {
    const dep = pkg[field]?.['@openpalm/lib'];
    if (typeof dep === 'string' && dep.startsWith('>=')) {
      pkg[field]['@openpalm/lib'] = `>=${version} <${major + 1}.0.0`;
    }
  }
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
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
