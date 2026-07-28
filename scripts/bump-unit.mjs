#!/usr/bin/env node
// bump-unit.mjs — compute next version for a release unit and stamp unit files.
//
// Env in:
//   UNIT    — platform | portals | assistant | guardian | images | electron | all
//   BUMP    — patch | minor | major  (ignored when UNIT=images)
//   STAMP   — 'true' to write files in place; any other value = compute-only (dry preview)
//   VERSION_OVERRIDE — optional explicit semver; skips bump computation
//
// Out (when GITHUB_OUTPUT is set):
//   new_version=X.Y.Z
//   current_version=X.Y.Z
//   tag_prefix=<unit>   (e.g. 'platform'; 'all' emits all per-unit as JSON in all_tags)
//
// Used by .github/workflows/release.yml.
// Preview locally: UNIT=platform BUMP=patch STAMP=false node scripts/bump-unit.mjs

import { readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareSemver, parseSemver, setVersion } from './set-version.mjs';

const RELEASE_PACKAGE_GROUPS = JSON.parse(
  readFileSync('.github/release-package-groups.json', 'utf8'),
).units;

// Highest version published on npm for a package name (null only when the
// package has never been published). Registry/network errors fail closed.
function maxPublished(name) {
  let vs;
  try {
    vs = JSON.parse(
      execFileSync('npm', ['view', name, 'versions', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString(),
    );
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr)
      : String(error);
    if (/E404|not found/i.test(stderr)) return null;
    throw new Error(`Could not query npm versions for ${name}: ${stderr.trim() || 'unknown registry error'}`);
  }
  if (!Array.isArray(vs)) vs = vs ? [vs] : [];
  let mx = null;
  for (const v of vs) { if (mx === null || compareSemver(v, mx) > 0) mx = v; }
  return mx;
}

// The bootstrap is the platform unit's only public npm package. Private source
// workspaces are stamped locally but never queried as registry authorities.
const PLATFORM_NPM_PACKAGES = ['openpalm'];

// Bump a disk-version anchor up to the highest version published across the
// given npm package names. Registry failures throw; only an npm 404 is treated
// as an unpublished package.
function anchorFromPublished(diskVersion, npmPackages) {
  let anchor = diskVersion;
  for (const name of npmPackages) {
    const published = maxPublished(name);
    if (published && compareSemver(published, anchor) > 0) anchor = published;
  }
  return anchor;
}

function platformAnchor() {
  return anchorFromPublished(readJsonVersion('package.json'), PLATFORM_NPM_PACKAGES);
}

const GUARDIAN_NPM_PACKAGES = ['@openpalm/guardian'];
const ALL_NPM_PACKAGES = [
  ...PLATFORM_NPM_PACKAGES,
  ...GUARDIAN_NPM_PACKAGES,
  '@openpalm/portal-sdk',
  '@openpalm/discord-portal',
  '@openpalm/slack-portal',
];

function guardianAnchor() {
  return anchorFromPublished(readJsonVersion('packages/guardian/package.json'), GUARDIAN_NPM_PACKAGES);
}

function bumpVersion(current, type) {
  const parsed = parseSemver(current);
  if (!parsed) throw new Error(`Cannot parse version: ${current}`);
  const { ma, mi, pa } = parsed;
  switch (type) {
    case 'major': return `${ma + 1}.0.0`;
    case 'minor': return `${ma}.${mi + 1}.0`;
    case 'patch': return `${ma}.${mi}.${pa + 1}`;
    default: throw new Error(`Unknown bump type: ${type}`);
  }
}

function readJsonVersion(file) {
  return JSON.parse(readFileSync(file, 'utf8')).version;
}

function readFileVersion(file) {
  return readFileSync(file, 'utf8').trim();
}

export function localUnitAnchorVersions() {
  return {
    platform: readJsonVersion(RELEASE_PACKAGE_GROUPS.platform[0]),
    portals: readJsonVersion(RELEASE_PACKAGE_GROUPS.portals[0]),
    guardian: readJsonVersion(RELEASE_PACKAGE_GROUPS.guardian[0]),
    assistant: readFileVersion('containers/assistant/VERSION'),
    electron: readJsonVersion(RELEASE_PACKAGE_GROUPS.electron[0]),
  };
}

export function highestVersion(versions) {
  let highest = null;
  for (const version of versions) {
    if (!parseSemver(version)) throw new Error(`Cannot parse version: ${version}`);
    if (highest === null || compareSemver(version, highest) > 0) highest = version;
  }
  if (highest === null) throw new Error('At least one version anchor is required');
  return highest;
}

export function assertVersionExceedsAnchors(target, anchors) {
  if (!parseSemver(target)) throw new Error(`Cannot parse target version: ${target}`);
  for (const [unit, current] of Object.entries(anchors)) {
    if (!parseSemver(current)) throw new Error(`Cannot parse ${unit} anchor version: ${current}`);
    if (compareSemver(target, current) <= 0) {
      throw new Error(`Target ${target} must be greater than ${unit} anchor ${current}`);
    }
  }
}

function allAnchor() {
  const localAnchor = highestVersion(Object.values(localUnitAnchorVersions()));
  return anchorFromPublished(localAnchor, ALL_NPM_PACKAGES);
}

function stampJsonFiles(files, version) {
  for (const f of files) {
    if (!existsSync(f)) throw new Error(`Cannot stamp: file not found: ${f}`);
    setVersion(f, version);
    console.log(`  ${f} → ${version}`);
  }
}

function stampVersionFile(file, version) {
  if (!existsSync(file)) throw new Error(`Cannot stamp: file not found: ${file}`);
  writeFileSync(file, `${version}\n`);
  console.log(`  ${file} → ${version}`);
}

// Unit definitions: anchor file (for reading current version) and files to stamp.
//
// IMPORTANT — version anchor semantics:
// Each unit's anchorFn reads that unit's OWN last independent release version,
// NOT the current platform version. It is normal for assistant/guardian/portals
// anchors to lag behind the platform version (e.g. platform=0.12.6, assistant=0.12.5)
// when those units have not had an independent release since the last platform cut.
// DO NOT stamp assistant/guardian/portals anchors during platform CI runs — that
// would couple independent units and generate noisy no-op commits.
// Docker push tags in release.yml come from the computed release target, not
// these package anchors. Anchors only compute an independent unit's next version.
const UNITS = {
  platform: {
    diskAnchorFn: () => readJsonVersion('package.json'),
    anchorFn: () => platformAnchor(),
    stamp(version) {
      stampJsonFiles(RELEASE_PACKAGE_GROUPS.platform, version);
    },
  },
  portals: {
    diskAnchorFn: () => readJsonVersion('portals/discord/package.json'),
    anchorFn: () => readJsonVersion('portals/discord/package.json'),
    stamp(version) {
      stampJsonFiles(RELEASE_PACKAGE_GROUPS.portals, version);
    },
  },
  assistant: {
    diskAnchorFn: () => readFileVersion('containers/assistant/VERSION'),
    anchorFn: () => readFileVersion('containers/assistant/VERSION'),
    stamp(version) {
      stampVersionFile('containers/assistant/VERSION', version);
    },
  },
  guardian: {
    diskAnchorFn: () => readJsonVersion('packages/guardian/package.json'),
    anchorFn: () => guardianAnchor(),
    stamp(version) {
      stampJsonFiles(RELEASE_PACKAGE_GROUPS.guardian, version);
    },
  },
  // Images-only unit: rebuilds Docker images at the current platform version without
  // publishing npm. No files are stamped; no version bump is applied by default.
  // Provide an explicit --version override to tag images at a new version.
  images: {
    diskAnchorFn: () => readJsonVersion('package.json'),
    anchorFn: () => readJsonVersion('package.json'),
    stamp(_version) { /* no files to stamp for images-only release */ },
  },
  electron: {
    diskAnchorFn: () => readJsonVersion('packages/electron/package.json'),
    anchorFn: () => readJsonVersion('packages/electron/package.json'),
    stamp(version) {
      stampJsonFiles(RELEASE_PACKAGE_GROUPS.electron, version);
    },
  },
};

// Guard the CLI entrypoint so `scripts/bump-unit.mjs` can be imported as a
// module (to unit-test individual stamp functions) without executing the
// "require UNIT or exit(1)" script body. Mirrors `require.main === module`.
let isMainModule = false;
try {
  isMainModule = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isMainModule = false;
}

if (isMainModule) {
  runCli();
}

function runCli() {
  const unit = process.env.UNIT;
  const bump = process.env.BUMP || 'patch';
  const doStamp = process.env.STAMP === 'true';
  const versionOverride = process.env.VERSION_OVERRIDE?.trim() || null;

  if (!unit) {
    console.error('Error: UNIT env var is required (platform|portals|assistant|guardian|images|electron|all)');
    process.exit(1);
  }
  if (versionOverride && !parseSemver(versionOverride)) {
    console.error(`Error: Cannot parse VERSION_OVERRIDE: ${versionOverride}`);
    process.exit(1);
  }

  let newVersion;
  let currentVersion;
  const out = process.env.GITHUB_OUTPUT;

  if (unit === 'images') {
    // Images-only release: read current platform version, no bump.
    // Use --version override to tag images at a specific version.
    currentVersion = UNITS.images.anchorFn();
    newVersion = versionOverride ?? currentVersion;
    console.log(
      versionOverride
        ? `images: ${currentVersion} → ${newVersion} (explicit version)`
        : `images: using current platform version ${newVersion} (no bump; use version override for a new tag)`,
    );
    if (out) {
      appendFileSync(out, `${[
        `current_version=${currentVersion}`,
        `new_version=${newVersion}`,
        `tag_prefix=images`,
      ].join('\n')}\n`);
    }
  } else if (unit === 'all') {
    // All-units release: stamp every unit to the same version using the specified bump type.
    // Unlike the old 'major' unit, 'all' accepts any bump type (patch/minor/major) and
    // accepts an explicit version override for coordinated point releases.
    const localAnchors = localUnitAnchorVersions();
    if (versionOverride) {
      try {
        assertVersionExceedsAnchors(versionOverride, localAnchors);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    }
    currentVersion = versionOverride ? highestVersion(Object.values(localAnchors)) : allAnchor();
    newVersion = versionOverride ?? bumpVersion(currentVersion, bump);
    console.log(
      `All-units release: ${currentVersion} → ${newVersion} (${versionOverride ? 'explicit version' : `${bump} bump`})`,
    );
    console.log('Files to stamp:');
    if (doStamp) {
      for (const [name, cfg] of Object.entries(UNITS)) {
        console.log(`\n  [${name}]`);
        cfg.stamp(newVersion);
      }
    } else {
      console.log('  (STAMP=false — preview only)');
      for (const name of Object.keys(UNITS)) {
        const cur = versionOverride ? UNITS[name].diskAnchorFn() : UNITS[name].anchorFn();
        console.log(`  ${name}: ${cur} → ${newVersion}`);
      }
    }
    // Emit per-unit tag list for the all-units release job
    const allTags = Object.keys(UNITS).filter(n => n !== 'images').map(n => `${n}-${newVersion}`);
    if (out) {
      appendFileSync(out, `${[
        `current_version=${currentVersion}`,
        `new_version=${newVersion}`,
        `tag_prefix=all`,
        `all_tags=${JSON.stringify(allTags)}`,
      ].join('\n')}\n`);
    }
  } else {
    const cfg = UNITS[unit];
    if (!cfg) {
      console.error(`Error: Unknown unit '${unit}'. Must be platform|portals|assistant|guardian|images|electron|all`);
      process.exit(1);
    }
    currentVersion = versionOverride ? cfg.diskAnchorFn() : cfg.anchorFn();
    newVersion = versionOverride ?? bumpVersion(currentVersion, bump);
    console.log(
      `${unit}: ${currentVersion} → ${newVersion} (${versionOverride ? 'explicit version' : `${bump} bump`})`,
    );
    if (doStamp) {
      cfg.stamp(newVersion);
    } else {
      console.log('  (STAMP=false — preview only)');
    }
    if (out) {
      appendFileSync(out, `${[
        `current_version=${currentVersion}`,
        `new_version=${newVersion}`,
        `tag_prefix=${unit}`,
      ].join('\n')}\n`);
    }
  }

  console.log(`\nResult: ${newVersion}`);
}
