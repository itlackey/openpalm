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
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setVersion } from './set-version.mjs';

// Parse a semver into comparable parts (prerelease-aware).
function parseSemver(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  return m ? { ma: +m[1], mi: +m[2], pa: +m[3], pre: m[4] || null } : null;
}

function cmpPre(a, b) {
  if (a === b) return 0;
  if (a === null) return 1; // no prerelease > prerelease
  if (b === null) return -1;
  const ai = a.split('.'), bi = b.split('.');
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    if (ai[i] === undefined) return -1;
    if (bi[i] === undefined) return 1;
    const an = /^[0-9]+$/.test(ai[i]), bn = /^[0-9]+$/.test(bi[i]);
    if (an && bn) { if (+ai[i] !== +bi[i]) return +ai[i] > +bi[i] ? 1 : -1; }
    else if (ai[i] !== bi[i]) return ai[i] > bi[i] ? 1 : -1;
  }
  return 0;
}

function cmpSemver(a, b) {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) return null;
  for (const k of ['ma', 'mi', 'pa']) { if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1; }
  return cmpPre(x.pre, y.pre);
}

// Highest version published on npm for a package name (null if unpublished/unknown).
function maxPublished(name) {
  let vs;
  try {
    vs = JSON.parse(
      execSync(`npm view ${name} versions --json`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString(),
    );
  } catch {
    return null;
  }
  if (!Array.isArray(vs)) vs = vs ? [vs] : [];
  let mx = null;
  for (const v of vs) { if (mx === null || cmpSemver(v, mx) > 0) mx = v; }
  return mx;
}

// Compute the platform anchor as the highest of the on-disk root version and the
// highest version published across ALL npm packages the platform unit publishes
// (lib, cli, ui, AND the dual-owned skeleton + guardian). skeleton/guardian are
// also published by the independent `guardian` unit, so they can be ahead of the
// root package.json on disk. Anchoring on the max prevents the platform release
// from computing a next version that collides with an already-published
// skeleton/guardian (the "cannot publish over previously published" failure).
const PLATFORM_NPM_PACKAGES = ['@openpalm/lib', 'openpalm', '@openpalm/ui', '@openpalm/client', '@openpalm/skeleton', '@openpalm/guardian'];

// Bump a disk-version anchor up to the highest version published across the
// given npm package names. npm failures return null and are ignored, so this
// degrades gracefully to the on-disk value in offline/test contexts.
function anchorFromPublished(diskVersion, npmPackages) {
  let anchor = diskVersion;
  for (const name of npmPackages) {
    const published = maxPublished(name);
    if (published && cmpSemver(published, anchor) > 0) anchor = published;
  }
  return anchor;
}

function platformAnchor() {
  return anchorFromPublished(readJsonVersion('package.json'), PLATFORM_NPM_PACKAGES);
}

// The guardian unit publishes @openpalm/guardian + @openpalm/skeleton (thin-host
// needs both). Both are dual-owned with the platform unit, so the on-disk guardian
// package.json can lag behind what's already on npm. Anchor on the max-published to
// avoid computing a colliding next version.
const GUARDIAN_NPM_PACKAGES = ['@openpalm/guardian', '@openpalm/skeleton'];

function guardianAnchor() {
  return anchorFromPublished(readJsonVersion('packages/guardian/package.json'), GUARDIAN_NPM_PACKAGES);
}

function bumpVersion(current, type) {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) throw new Error(`Cannot parse version: ${current}`);
  let [, ma, mi, pa] = m;
  ma = +ma; mi = +mi; pa = +pa;
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

function stampJsonFiles(files, version) {
  for (const f of files) {
    if (!existsSync(f)) throw new Error(`Cannot stamp: file not found: ${f}`);
    setVersion(f, version);
    console.log(`  ${f} → ${version}`);
  }
}

function stampSetupScripts(version) {
  for (const [file, pattern, replacement] of [
    ['scripts/setup.sh', /^SCRIPT_VERSION=".*"/m, `SCRIPT_VERSION="${version}"`],
    ['scripts/setup.ps1', /^\$ScriptVersion = '.*'/m, `$ScriptVersion = '${version}'`],
  ]) {
    const content = readFileSync(file, 'utf8');
    const updated = content.replace(pattern, replacement);
    writeFileSync(file, updated);
    console.log(`  ${file} → ${version}`);
  }
}

function stampVersionFile(file, version) {
  if (!existsSync(file)) throw new Error(`Cannot stamp: file not found: ${file}`);
  writeFileSync(file, `${version}\n`);
  console.log(`  ${file} → ${version}`);
}

// C1 (2026-07-10 review): the operator-managed portal-tools seed
// (packages/skeleton/data/portal/tools/package.json, copied to
// OP_HOME/data/portal/tools at install) pins the discord/slack portal
// adapters with a `^0.12.0` caret range. Caret ranges on a 0.x version only
// float the PATCH digit (^0.12.0 means >=0.12.0 <0.13.0 per semver), so it
// silently never picks up a 0.13.x (or later minor) adapter release. Advance
// the range's floor to the version just published so operators keep getting
// adapter updates within that minor line, the same way containers/portal/
// start.sh's own comment describes ("semver advance ... at release time").
// Regex-replaces in place (not JSON.parse/stringify) to avoid reformatting
// the file's hand-aligned columns.
export const PORTAL_TOOLS_SEED_FILE = 'packages/skeleton/data/portal/tools/package.json';

export function stampPortalToolsSeedRanges(version, file = PORTAL_TOOLS_SEED_FILE) {
  if (!existsSync(file)) throw new Error(`Cannot stamp: file not found: ${file}`);
  const content = readFileSync(file, 'utf8');
  const updated = content
    .replace(/("@openpalm\/discord-portal":\s*")\^[^"]*(")/, `$1^${version}$2`)
    .replace(/("@openpalm\/slack-portal":\s*")\^[^"]*(")/, `$1^${version}$2`);
  writeFileSync(file, updated);
  console.log(`  ${file} → ^${version} (discord/slack-portal ranges)`);
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
// Docker push tags in release.yml come from OP_IMAGE_TAG / v${PLATFORM_VERSION},
// not from these anchors. Anchors are only read here to compute the NEXT version
// for an independent unit release.
const UNITS = {
  platform: {
    anchorFn: () => platformAnchor(),
    stamp(version) {
      stampJsonFiles([
        'package.json',
        'packages/skeleton/package.json',
        'packages/lib/package.json',
        'packages/guardian/package.json',
        'packages/cli/package.json',
        'packages/ui/package.json',
        'packages/client/package.json',
        'packages/ui-kit/package.json',
        'packages/electron/package.json',
        'packages/electron/admin-tools/package.json',
      ], version);
      stampSetupScripts(version);
    },
  },
  portals: {
    anchorFn: () => readJsonVersion('portals/discord/package.json'),
    stamp(version) {
      stampJsonFiles([
        'packages/portal-sdk/package.json',
        'portals/discord/package.json',
        'portals/slack/package.json',
      ], version);
      // Advance the operator-managed seed's adapter ranges alongside the
      // adapters themselves (C1) — otherwise the seed's `^0.12.0` caret range
      // never reaches a 0.13.x+ adapter for any existing OP_HOME install.
      stampPortalToolsSeedRanges(version);
    },
  },
  assistant: {
    anchorFn: () => readFileVersion('containers/assistant/VERSION'),
    stamp(version) {
      stampVersionFile('containers/assistant/VERSION', version);
    },
  },
  guardian: {
    anchorFn: () => guardianAnchor(),
    stamp(version) {
      stampJsonFiles(['packages/guardian/package.json'], version);
    },
  },
  // Images-only unit: rebuilds Docker images at the current platform version without
  // publishing npm. No files are stamped; no version bump is applied by default.
  // Provide an explicit --version override to tag images at a new version.
  images: {
    anchorFn: () => readJsonVersion('package.json'),
    stamp(_version) { /* no files to stamp for images-only release */ },
  },
  electron: {
    anchorFn: () => readJsonVersion('packages/electron/package.json'),
    stamp(version) {
      stampJsonFiles([
        'packages/electron/package.json',
        'packages/electron/admin-tools/package.json',
      ], version);
    },
  },
};

// Guard the CLI entrypoint so `scripts/bump-unit.mjs` can be imported as a
// module (e.g. by scripts/portal-tools-seed-range.test.ts, to unit-test
// stampPortalToolsSeedRanges directly) without executing the "require UNIT or
// exit(1)" script body. Mirrors the classic `require.main === module` idiom.
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
    currentVersion = UNITS.platform.anchorFn();
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
        const cur = UNITS[name].anchorFn();
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
    currentVersion = cfg.anchorFn();
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
