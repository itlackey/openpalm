#!/usr/bin/env node
// Single source of truth for stamping a package.json's version.
//
// Product workspaces are source-only and use workspace:* references, so release
// stamping changes only each manifest's own version. Used by bump-unit.mjs and
// release workflows so there is exactly one place that writes that field.
import { readFileSync, writeFileSync } from 'node:fs';

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

/** Stamp `version` into a package.json file (in place). Returns the new version. */
export function setVersion(file, version) {
  if (!parseSemver(version)) {
    throw new Error(`version must be semver (e.g. 1.2.3 or 1.2.3-rc1), got '${version}'`);
  }
  const pkg = JSON.parse(readFileSync(file, 'utf-8'));
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  return version;
}
