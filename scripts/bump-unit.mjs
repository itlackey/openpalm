#!/usr/bin/env node
// bump-unit.mjs — stamp a release unit's manifests to an explicit version.
//
// Env in:
//   UNIT    — a unit key from .github/release-package-groups.json
//             (platform | electron | portals | guardian)
//   STAMP   — 'true' to write files in place; any other value = preview only
//   VERSION — explicit semver to stamp (required)
//
// Used by .github/workflows/release.yml.
// Preview locally: UNIT=platform VERSION=1.2.3 node scripts/bump-unit.mjs

import { existsSync, readFileSync } from 'node:fs';
import { parseSemver, setVersion } from './set-version.mjs';

const RELEASE_PACKAGE_GROUPS = JSON.parse(
  readFileSync('.github/release-package-groups.json', 'utf8'),
).units;

const unit = process.env.UNIT;
const version = process.env.VERSION?.trim() || null;
const doStamp = process.env.STAMP === 'true';

const files = unit ? RELEASE_PACKAGE_GROUPS[unit] : undefined;
if (!files) {
  console.error(`Error: UNIT env var must be one of ${Object.keys(RELEASE_PACKAGE_GROUPS).join('|')}`);
  process.exit(1);
}
if (!version || !parseSemver(version)) {
  console.error(`Error: Cannot parse VERSION: ${version ?? '(unset)'}`);
  process.exit(1);
}

console.log(`${unit} → ${version}${doStamp ? '' : ' (STAMP=false — preview only)'}`);
for (const f of files) {
  if (!existsSync(f)) {
    console.error(`Error: Cannot stamp: file not found: ${f}`);
    process.exit(1);
  }
  if (doStamp) setVersion(f, version);
  console.log(`  ${f} → ${version}`);
}
