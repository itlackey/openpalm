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
import { parseSemver, setComposeImageTags, setVersion } from './set-version.mjs';

const RELEASE_GROUPS = JSON.parse(readFileSync('.github/release-package-groups.json', 'utf8'));
const RELEASE_PACKAGE_GROUPS = RELEASE_GROUPS.units;
// Compose files carrying the platform image-tag defaults. Kept OUTSIDE `units`
// on purpose: gates.yml reads every entry under `units` with `jq -r .version`,
// which only works on a package.json.
const COMPOSE_IMAGE_TAG_FILES = RELEASE_GROUPS.composeImageTagFiles ?? [];

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

// The image tag a release deploys is the `:-` default in the compose files it
// ships (#679), stamped from the same VERSION in the same run as
// packages/lib/package.json — which is where PLATFORM_VERSION comes from — so
// the two cannot disagree in a committed state.
if (unit === 'platform') {
  for (const f of COMPOSE_IMAGE_TAG_FILES) {
    if (!existsSync(f)) {
      console.error(`Error: Cannot stamp: file not found: ${f}`);
      process.exit(1);
    }
    const count = doStamp ? setComposeImageTags(f, version) : '(preview)';
    console.log(`  ${f} → image tags ${version} ${doStamp ? `(${count} refs)` : '(preview)'}`);
  }
}
