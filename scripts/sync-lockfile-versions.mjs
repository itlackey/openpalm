#!/usr/bin/env node
// sync-lockfile-versions.mjs — true up bun.lock's per-workspace "version"
// fields to match each workspace's package.json.
//
// `bun install --lockfile-only` does not rewrite a workspace's own
// "version" entry in bun.lock when nothing else about its dependency graph
// changed: workspace:* references resolve by path, not by version number,
// so a version-only bump in package.json doesn't invalidate bun's
// lockfile-only fast path. Left alone, bun.lock silently drifts from the
// package.json versions on every release (see release issue #633). This
// patches only the "version" string for each stamped workspace, leaving
// every resolved dependency untouched.
//
// Used by .github/workflows/release.yml, right after bump-unit.mjs and
// `bun install --lockfile-only`.
// Preview locally: node scripts/sync-lockfile-versions.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const LOCKFILE = 'bun.lock';

const RELEASE_PACKAGE_GROUPS = JSON.parse(
	readFileSync('.github/release-package-groups.json', 'utf8')
).units;
const files = [...new Set(Object.values(RELEASE_PACKAGE_GROUPS).flat())];

let lock = readFileSync(LOCKFILE, 'utf8');
let changed = 0;

for (const file of files) {
	const dir = file === 'package.json' ? '' : dirname(file);
	const pkg = JSON.parse(readFileSync(file, 'utf8'));
	if (!pkg.version) continue;

	const key = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// Match the workspace's block up to (but not into) its first nested
	// object, so this only ever touches a "version" field that appears
	// before "bin"/"dependencies"/etc. — never a nested package's.
	const re = new RegExp(`("${key}":\\s*{[^{}]*?"version":\\s*)"([^"]*)"`);
	const match = lock.match(re);
	if (!match) continue; // no recorded version for this workspace — nothing to true up

	if (match[2] !== pkg.version) {
		lock = lock.replace(re, `$1"${pkg.version}"`);
		console.log(`  ${dir || '.'}: ${match[2]} → ${pkg.version}`);
		changed++;
	}
}

if (changed > 0) {
	writeFileSync(LOCKFILE, lock);
	console.log(`sync-lockfile-versions: trued up ${changed} workspace version(s) in ${LOCKFILE}`);
} else {
	console.log('sync-lockfile-versions: bun.lock already matches package.json versions');
}
