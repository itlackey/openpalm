#!/usr/bin/env node
// Stamp every release manifest and Compose image default to one explicit version.
//
// Env in:
//   STAMP   — 'true' to write files in place; any other value = preview only
//   VERSION — explicit semver to stamp (required)
//
// Preview locally: VERSION=1.2.3 node scripts/bump-release.mjs

import { existsSync, readFileSync } from 'node:fs';
import { parseSemver, setComposeImageTags, setVersion } from './set-version.mjs';

const RELEASE = JSON.parse(readFileSync('.github/release-manifest.json', 'utf8'));
const manifests = RELEASE.manifests ?? [];
const composeFiles = RELEASE.compose ?? [];

const version = process.env.VERSION?.trim() || null;
const doStamp = process.env.STAMP === 'true';

if (!version || !parseSemver(version)) {
	console.error(`Error: Cannot parse VERSION: ${version ?? '(unset)'}`);
	process.exit(1);
}

console.log(`OpenPalm → ${version}${doStamp ? '' : ' (STAMP=false — preview only)'}`);
for (const f of manifests) {
	if (!existsSync(f)) {
		console.error(`Error: Cannot stamp: file not found: ${f}`);
		process.exit(1);
	}
	if (doStamp) setVersion(f, version);
	console.log(`  ${f} → ${version}`);
}

for (const f of composeFiles) {
	if (!existsSync(f)) {
		console.error(`Error: Cannot stamp: file not found: ${f}`);
		process.exit(1);
	}
	const count = doStamp ? setComposeImageTags(f, version) : '(preview)';
	console.log(`  ${f} → image tags ${version} ${doStamp ? `(${count} refs)` : '(preview)'}`);
}
